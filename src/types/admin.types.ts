export interface CreateClientRequest {
  name: string;
  email: string;
  phone: string;
  panNumber: string;
  password?: string;
  status?: 'active' | 'inactive';
}

export interface AdminClientItem {
  uid: string;
  name: string;
  email: string;
  phone: string;
  panNumber: string;
  role: 'client';
  status: 'active' | 'inactive';
  driveFolderId?: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreateClientResponse {
  uid: string;
  name: string;
  email: string;
  phone: string;
  panNumber: string;
  role: 'client';
  status: 'active' | 'inactive';
  driveFolderId: string;
  panUploadFolderId: string;
  createdAt: string;
  updatedAt: string;
}

export type AdminFolderType = 'pan_root' | 'upload_folder' | 'subfolder';
export type AdminUploaderType = 'administrator' | 'client';

export interface AdminClientDocumentItem {
  documentId: string;
  name: string;
  mimeType: string;
  size: string;
  createdTime: string;
  modifiedTime: string;
  folderType: AdminFolderType;
  uploaderType: AdminUploaderType;
  uploaderName: string;
  isFolder?: boolean;
  isPasswordProtected?: boolean;
}

export interface AdminClientUploadFolderInfo {
  id: string;
  name: string;
  mimeType: string;
  folderType: 'upload_folder';
}

export interface AdminClientDocumentsResponse {
  clientId: string;
  panFolderId: string;
  uploadFolder: AdminClientUploadFolderInfo | null;
  documents: AdminClientDocumentItem[];
  total: number;
}

