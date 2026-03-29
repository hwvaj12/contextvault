<?php

declare(strict_types=1);

namespace ContextVault;

use GuzzleHttp\RequestOptions;

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
     * @param string $customerId Customer identifier
     * @param string $name       Workspace name
     * @return array Created workspace data
     */
    public function create(string $customerId, string $name): array
    {
        return $this->client->request('POST', '/api/workspaces', [
            RequestOptions::JSON => [
                'customerId' => $customerId,
                'name' => $name,
            ],
        ]);
    }

    /**
     * List workspaces for a customer.
     *
     * @param string $customerId Customer identifier
     * @return array List of workspaces
     */
    public function list(string $customerId): array
    {
        return $this->client->request('GET', '/api/workspaces', [
            RequestOptions::QUERY => [
                'customerId' => $customerId,
            ],
        ]);
    }

    /**
     * Get a workspace by ID.
     *
     * @param string $workspaceId Workspace identifier
     * @return array Workspace data
     */
    public function get(string $workspaceId): array
    {
        return $this->client->request('GET', "/api/workspaces/{$workspaceId}");
    }

    /**
     * Delete a workspace.
     *
     * @param string $workspaceId Workspace identifier
     * @return array Response data
     */
    public function delete(string $workspaceId): array
    {
        return $this->client->request('DELETE', "/api/workspaces/{$workspaceId}");
    }

    /**
     * Checkout a workspace sandbox for editing.
     *
     * @param string $workspaceId Workspace identifier
     * @return array Sandbox data including path
     */
    public function checkout(string $workspaceId): array
    {
        return $this->client->request('POST', "/api/workspaces/{$workspaceId}/checkout");
    }

    /**
     * Commit changes in a workspace sandbox.
     *
     * @param string $workspaceId Workspace identifier
     * @param string $message     Commit message
     * @param string $author      Commit author
     * @return array Commit result data
     */
    public function commit(string $workspaceId, string $message, string $author): array
    {
        return $this->client->request('POST', "/api/workspaces/{$workspaceId}/commit", [
            RequestOptions::JSON => [
                'message' => $message,
                'author' => $author,
            ],
        ]);
    }

    /**
     * Destroy a workspace sandbox (clean up after checkout).
     *
     * @param string $workspaceId Workspace identifier
     * @return array Response data
     */
    public function destroy(string $workspaceId): array
    {
        return $this->client->request('POST', "/api/workspaces/{$workspaceId}/destroy");
    }

    /**
     * Pull (list) all files in a workspace.
     *
     * @param string $workspaceId Workspace identifier
     * @return array File listing
     */
    public function pull(string $workspaceId): array
    {
        return $this->client->request('GET', "/api/workspaces/{$workspaceId}/files");
    }

    /**
     * Get a specific file from a workspace.
     *
     * @param string $workspaceId Workspace identifier
     * @param string $filePath    Path to file within workspace
     * @return array File data
     */
    public function getFile(string $workspaceId, string $filePath): array
    {
        $encodedPath = implode('/', array_map('rawurlencode', explode('/', $filePath)));

        return $this->client->request('GET', "/api/workspaces/{$workspaceId}/files/{$encodedPath}");
    }

    /**
     * Get commit history for a workspace.
     *
     * @param string $workspaceId Workspace identifier
     * @return array Commit history
     */
    public function history(string $workspaceId): array
    {
        return $this->client->request('GET', "/api/workspaces/{$workspaceId}/history");
    }
}
