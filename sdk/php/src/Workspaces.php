<?php

declare(strict_types=1);

namespace ContextVault;

use ContextVault\Exception\ConflictError;
use ContextVault\Exception\NotFoundError;
use ContextVault\Exception\ValidationError;
use ContextVault\Exception\NetworkError;
use ContextVault\Exception\AuthError;
use ContextVault\Exception\ContextVaultException;
use GuzzleHttp\RequestOptions;

/**
 * Client-local lifecycle wrappers and retained legacy server endpoint seams.
 * Listing, administration, and history depend on server compatibility support.
 */
class Workspaces
{
    private Client $client;
    /** @var array<string, WorkspaceSession> */
    private array $handles = [];

    public function __construct(Client $client)
    {
        $this->client = $client;
    }

    /**
     * Create a new workspace.
     *
     * @param string $customerId Customer identifier.
     * @param string $name       Workspace name.
     * @return array V1 workspace data. The wrapper retains its durable local session.
     */
    public function create(string $customerId, string $name): array
    {
        $session = $this->client->createWorkspace($customerId, $name);
        $id = $session->state()['workspaceId']; $this->handles[$id] = $session;
        return $this->client->request('GET', '/v1/workspaces/' . rawurlencode($id));
    }

    /**
     * List workspaces, optionally filtered by customer.
     *
     * @param string|null $customerId Optional customer identifier filter.
     * @return array<int, array> List of workspaces.
     */
    public function list(?string $customerId = null): array
    {
        $query = [];
        if ($customerId !== null) {
            $query['customerId'] = $customerId;
        }

        return $this->client->request('GET', '/workspaces', [
            RequestOptions::QUERY => $query,
        ]);
    }

    /**
     * Get a single workspace by ID.
     *
     * @param string $workspaceId Workspace identifier.
     * @return array Workspace data.
     * @throws NotFoundError When workspace is not found.
     */
    public function get(string $workspaceId): array
    {
        $encodedId = rawurlencode($workspaceId);
        return $this->client->request('GET', "/v1/workspaces/{$encodedId}");
    }

    /**
     * Soft-delete a workspace.
     *
     * @param string $workspaceId Workspace identifier.
     * @return void
     * @throws NotFoundError When workspace is not found.
     */
    public function delete(string $workspaceId): void
    {
        $encodedId = rawurlencode($workspaceId);
        $this->client->request('DELETE', "/workspaces/{$encodedId}");
    }

    /**
     * Hard-delete multiple workspaces (removes DB records, repos, and sandboxes).
     *
     * @param string[] $workspaceIds List of workspace IDs to delete.
     * @return array{deleted: int, failed: array<int, array{id: string, error: string}>}
     */
    public function bulkDelete(array $workspaceIds): array
    {
        return $this->client->request('POST', '/workspaces/bulk-delete', [
            RequestOptions::JSON => [
                'workspaceIds' => $workspaceIds,
            ],
        ]);
    }

    /**
     * Clone a workspace to a new customer (or same customer).
     *
     * @param string      $workspaceId      Source workspace identifier.
     * @param string      $targetCustomerId Customer who will own the clone.
     * @param string|null $name             Optional name for the cloned workspace.
     * @return array Cloned workspace data.
     */
    public function clone(string $workspaceId, string $targetCustomerId, ?string $name = null): array
    {
        $encodedId = rawurlencode($workspaceId);
        $body = ['targetCustomerId' => $targetCustomerId];
        if ($name !== null) {
            $body['name'] = $name;
        }

        return $this->client->request('POST', "/workspaces/{$encodedId}/clone", [
            RequestOptions::JSON => $body,
        ]);
    }

    /**
     * Materialize a client-local workspace, or return this wrapper's existing local session.
     *
     * @param string $workspaceId Workspace identifier.
     * @return array Local path aliases, run identity, recovery path, and session handle.
     */
    public function checkout(string $workspaceId): array
    {
        $session = $this->handles[$workspaceId] ?? ($this->handles[$workspaceId] = $this->client->openWorkspace($workspaceId));
        $state = $session->state(); $path = $session->path();
        return ['workspaceId' => $workspaceId, 'runId' => $state['run']['id'], 'sandboxId' => $state['run']['id'],
            'path' => $path, 'sandboxPath' => $path, 'baseCommit' => $state['run']['baseRevisionId'],
            'recoveryPath' => $session->recoveryPath(), 'handle' => $session];
    }

    /**
     * Checkpoint stopped local writers, then open and hydrate the next ordinary run.
     *
     * @param string $workspaceId Workspace identifier.
     * @param array{
     *   writersStopped?: bool,
     *   message?: string,
     *   author?: string,
     *   agentId?: string,
     *   taskId?: string,
     *   tags?: string[]
     * } $options Commit options.
     * @return array Published revision, separate legacy status and v1 outcome, and next local run.
     * @throws ContextVaultException Legacy metadata options require future server compatibility support.
     */
    public function commit(string $workspaceId, array $options = []): array
    {
        if (!isset($this->handles[$workspaceId])) Manifest::fail('LOCAL_SESSION_NOT_FOUND', 'Checkout or resume the local session before committing');
        if (array_diff_key($options, array_flip(['writersStopped', 'message', 'author', 'agentId', 'taskId', 'tags']))) Manifest::fail('INVALID_REQUEST', 'Unknown compatibility commit option');
        // V1 has no commit metadata fields. Silently pretending to store old metadata would be misleading.
        foreach (['message', 'author', 'agentId', 'taskId', 'tags'] as $field) if (isset($options[$field])) Manifest::fail('UNSUPPORTED_CAPABILITY', 'Legacy commit metadata requires the future compatibility server');
        $session = $this->handles[$workspaceId]; $session->checkpoint(($options['writersStopped'] ?? false) === true);
        $result = $session->recovery()['workflow']['lastResult'];
        return ['workspaceId' => $workspaceId, 'commitId' => $result['revisionId'], 'status' => 'merged', 'outcome' => $result['runState'],
            'changed' => $result['changed'], 'runId' => $session->state()['run']['id'], 'path' => $session->path()];
    }

    /**
     * Explicitly abort a known active run and clean its stopped client-local writers' files.
     *
     * @param string $workspaceId Workspace identifier.
     * @return array Destroy result with workspaceId and status.
     */
    public function destroy(string $workspaceId, bool $writersStopped = false): array
    {
        if (!$writersStopped) Manifest::fail('WRITERS_NOT_STOPPED', 'Stop local writers before destroying client files');
        if (!isset($this->handles[$workspaceId])) Manifest::fail('LOCAL_SESSION_NOT_FOUND', 'Checkout or resume this local session first');
        $session = $this->handles[$workspaceId]; $status = $session->status();
        if ($status['state'] === 'active') $status = $session->abort('compatibility destroy', true);
        $cleanup = $session->cleanup(true); unset($this->handles[$workspaceId]);
        return ['workspaceId' => $workspaceId, 'status' => 'cleaned_up', 'outcome' => $status['state'], 'cleanup' => $cleanup];
    }

    /**
     * Materialize the latest pinned revision into a separate read-only client-local session.
     *
     * @param string      $workspaceId Workspace identifier.
     * @param string|null $version      Optional specific commit version to pull.
     * @return array Local path, complete manifest, pinned revision, and explicit lifecycle handle.
     */
    public function pull(string $workspaceId, ?string $version = null): array
    {
        if ($version !== null) Manifest::fail('UNSUPPORTED_CAPABILITY', 'Historical materialization requires the future compatibility server');
        $session = $this->client->openWorkspace($workspaceId, null, ['mode' => 'read-only']); $state = $session->state();
        return ['workspaceId' => $workspaceId, 'commitId' => $state['run']['baseRevisionId'], 'path' => $session->path(),
            'manifest' => $session->manifest(), 'handle' => $session];
    }

    /**
     * Get a single file from the latest commit of a workspace.
     *
     * @param string $workspaceId Workspace identifier.
     * @param string $filePath    Path to the file within the workspace.
     * @return array File path, readable byte stream, and its read-only session handle.
     */
    public function getFile(string $workspaceId, string $filePath): array
    {
        Manifest::path($filePath); $pull = $this->pull($workspaceId);
        try { return ['path' => $filePath, 'stream' => LocalFiles::openRegular($pull['path'], $filePath), 'handle' => $pull['handle']]; }
        catch (ContextVaultException $error) { throw $error->withRecoveryPath($pull['handle']->recoveryPath()); }
        catch (\Throwable $error) {
            throw (new ContextVaultException('Could not open the materialized file; retain its recovery identity', 0,
                ['error' => ['code' => 'LOCAL_IO_ERROR']], $error))->withRecoveryPath($pull['handle']->recoveryPath());
        }
    }

    /**
     * Compare two commits and return structured diff output.
     *
     * @param string $workspaceId Workspace identifier.
     * @param string $from        Source commit hash.
     * @param string $to          Target commit hash.
     * @return array Diff result with files array and summary.
     */
    public function diff(string $workspaceId, string $from, string $to): array
    {
        $encodedId = rawurlencode($workspaceId);
        $query = http_build_query(['from' => $from, 'to' => $to]);

        return $this->client->request('GET', "/workspaces/{$encodedId}/diff?{$query}");
    }

    /**
     * Get the commit history for a workspace.
     *
     * @param string  $workspaceId Workspace identifier.
     * @param int|null $limit      Optional maximum number of commits to return.
     * @return array History result with commits array and count.
     */
    public function history(string $workspaceId, ?int $limit = null): array
    {
        $encodedId = rawurlencode($workspaceId);
        $query = [];

        if ($limit !== null) {
            $query['limit'] = (string) $limit;
        }

        $path = $query ? "/workspaces/{$encodedId}/history?" . http_build_query($query) : "/workspaces/{$encodedId}/history";

        return $this->client->request('GET', $path);
    }
}
