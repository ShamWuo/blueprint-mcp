export interface FolderConnection {
  folderPath: string;
  workspaceId: string;
  workspaceName?: string;
  include?: string[];
  ignore?: string[];
  maxFileSizeBytes?: number;
  connectedAt?: string;
  updatedAt?: string;
}

export function connectFolder(options: {
  folderPath: string;
  workspaceId?: string;
  workspaceName?: string;
  include?: string[];
  ignore?: string[];
  maxFileSizeBytes?: number;
  configDir?: string;
}): Promise<{
  success: boolean;
  folder_path: string;
  workspace_id: string;
  workspace_name: string;
  config_path: string;
  message: string;
}>;

export function disconnectFolder(options: {
  folderPath: string;
  configDir?: string;
}): Promise<{
  success: boolean;
  folder_path: string;
  disconnected: boolean;
  message: string;
}>;

export function listConnectedFolders(options?: { configDir?: string }): Promise<{
  success: boolean;
  count: number;
  folders: Array<{
    folder_path: string;
    workspace_id: string;
    workspace_name: string;
    connected_at?: string;
    updated_at?: string;
    exists: boolean;
  }>;
}>;

export function resolveFolderConnection(
  folderPath: string,
  options?: { configDir?: string }
): Promise<FolderConnection | null>;

export function scanFolderFiles(
  folderPath: string,
  options?: {
    include?: string[];
    ignore?: string[];
    maxFileSizeBytes?: number;
  }
): Promise<{
  canonicalRoot: string;
  files: Array<{
    path: string;
    content: string;
    language: string;
    sizeBytes: number;
    sha256: string;
  }>;
  skipped: Array<{ path: string; reason: string; size_bytes?: number }>;
}>;

export function syncFolderToWorkspace(options: {
  folderPath: string;
  workspaceId?: string;
  dryRun?: boolean;
  force?: boolean;
  include?: string[];
  ignore?: string[];
  maxFileSizeBytes?: number;
  writeFileFn: (args: {
    path: string;
    content: string;
    language: string;
    workspace_id: string;
  }) => Promise<unknown>;
  configDir?: string;
}): Promise<{
  success: boolean;
  folder_path: string;
  workspace_id: string;
  dry_run: boolean;
  total_scanned: number;
  synced_count: number;
  skipped_count: number;
  failed_count: number;
  synced_files: Array<{ path: string; language: string; size_bytes: number; dry_run?: boolean }>;
  unchanged_count: number;
  ignored_or_skipped: Array<{ path: string; reason: string; size_bytes?: number }>;
  errors: Array<{ path: string; error: string }>;
}>;
