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
 * Workspace operations for the ContextVault API.
 *
 * @method create(string $customerId, string $name): array Create a new workspace.
 * @method list(?string $customerId = null): array List workspaces, optionally filtered.
 * @method get(string $workspaceId): array Get a workspace by ID.
 * @method delete(string $workspaceId): void Delete a workspace.
 * @method checkout(string $workspaceId): array Checkout a workspace (create a sandbox).
 * @method commit(string $workspaceId, array $options = []): array Commit sandbox changes.
 * @method destroy(string $workspaceId): array Destroy a workspace sandbox.
 * @method pull(string $workspaceId, ?string $version = null): array Pull latest files.
 * @method getFile(string $workspaceId, string $filePath): array Get a single file.
 * @method history(string $workspaceId, ?int $limit = null): array Get commit history.
 */
class Workspaces
{
    private Client $client;

    public function __construct(Client $client)
    {
        $this->client = $client;
    }

    /**
     * Create a new workspace.
     *
     * @param string $customerId Customer identifier.
     * @param string $name       Workspace name.
     * @return array Workspace data with id, customerId, name, latestCommitId, createdAt, updatedAt, deletedAt.
     */
    public function create(string $customerId, string $name): array
    {
        return $this->client->request('POST', '/workspaces', [
            RequestOptions::JSON => [
                'customerId' => $customerId,
                'name' => $name,
            ],
        ]);
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
        return $this->client->request('GET', "/workspaces/{$encodedId}");
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
     * Checkout a workspace (create a sandbox for editing).
     *
     * @param string $workspaceId Workspace identifier.
     * @return array Sandbox data with sandboxId, workspaceId, sandboxPath, createdAt.
     */
    public function checkout(string $workspaceId): array
    {
        $encodedId = rawurlencode($workspaceId);
        return $this->client->request('POST', "/workspaces/{$encodedId}/sandbox");
    }

    /**
     * Commit sandbox changes back to the workspace.
     *
     * @param string $workspaceId Workspace identifier.
     * @param array{
     *   message?: string,
     *   author?: string,
     *   agentId?: string,
     *   taskId?: string,
     *   tags?: string[]
     * } $options Commit options.
     * @return array Commit entry with commitId, workspaceId, parentId, metadata, sizeBytes, createdAt.
     */
    public function commit(string $workspaceId, array $options = []): array
    {
        $encodedId = rawurlencode($workspaceId);
        $body = [];

        if (isset($options['message'])) {
            $body['message'] = $options['message'];
        }
        if (isset($options['author'])) {
            $body['author'] = $options['author'];
        }
        if (isset($options['agentId'])) {
            $body['agentId'] = $options['agentId'];
        }
        if (isset($options['taskId'])) {
            $body['taskId'] = $options['taskId'];
        }
        if (isset($options['tags'])) {
            $body['tags'] = $options['tags'];
        }

        return $this->client->request('POST', "/workspaces/{$encodedId}/sandbox/commit", [
            RequestOptions::JSON => $body,
        ]);
    }

    /**
     * Destroy (tear down) the sandbox for a workspace.
     *
     * @param string $workspaceId Workspace identifier.
     * @return array Destroy result with workspaceId and status.
     */
    public function destroy(string $workspaceId): array
    {
        $encodedId = rawurlencode($workspaceId);
        return $this->client->request('DELETE', "/workspaces/{$encodedId}/sandbox");
    }

    /**
     * Pull the latest committed state (all files) for a workspace.
     *
     * @param string      $workspaceId Workspace identifier.
     * @param string|null $version      Optional specific commit version to pull.
     * @return array Pull result with commitId, workspaceId, files, metadata, sizeBytes, createdAt.
     */
    public function pull(string $workspaceId, ?string $version = null): array
    {
        $encodedId = rawurlencode($workspaceId);
        $query = [];

        if ($version !== null) {
            $query['version'] = $version;
        }

        $path = $query ? "/workspaces/{$encodedId}/pull?" . http_build_query($query) : "/workspaces/{$encodedId}/pull";

        return $this->client->request('GET', $path);
    }

    /**
     * Get a single file from the latest commit of a workspace.
     *
     * @param string $workspaceId Workspace identifier.
     * @param string $filePath    Path to the file within the workspace.
     * @return array File entry with path and content.
     */
    public function getFile(string $workspaceId, string $filePath): array
    {
        $encodedId = rawurlencode($workspaceId);
        $query = http_build_query(['path' => $filePath]);

        return $this->client->request('GET', "/workspaces/{$encodedId}/pull?{$query}");
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
