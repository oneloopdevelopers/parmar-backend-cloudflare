export interface DocumentItem {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  driveFolderId: string;
  createdAt: string;
  updatedAt?: string;
}

export interface DocumentUploadPayload {
  fileName: string;
  mimeType?: string;
  contentBase64?: string;
}

export interface DriveFolderSafeMetadata {
  id: string;
  name: string;
  mimeType: string;
}

export interface DriveFileSafeMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  createdTime: string;
  modifiedTime: string;
}

export interface DriveFolderTestResponse {
  success: boolean;
  folder: {
    name: string;
    mimeType: string;
  };
  files: DriveFileSafeMetadata[];
}

export interface DriveFileDetails {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  size?: string;
  trashed: boolean;
}

export interface DriveFileDownloadResult {
  stream: ReadableStream<Uint8Array> | null;
  contentLength?: string;
  contentType?: string;
}

export interface DriveFileUploadResult {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
}

export interface UploadFileParams {
  name: string;
  mimeType: string;
  parents: string[];
  content: Uint8Array;
}
