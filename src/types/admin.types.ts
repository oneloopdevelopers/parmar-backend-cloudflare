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
