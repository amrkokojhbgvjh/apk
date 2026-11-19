import type { Timestamp } from 'firebase/firestore';

export const SCHEMA_LIMITS = {
  ID_MAX: 128,
  NAME_MAX: 120,
  DESCRIPTION_MAX: 2000,
  ICON_DATA_URL_MAX: 250000,
  FILE_NAME_MAX: 200,
  FILE_SIZE_MAX: 524288000,
  FILE_SHA256_MAX: 64,
  PACKAGE_NAME_MAX: 180,
  VERSION_NAME_MAX: 60,
  UPLOADER_NAME_MAX: 120,
  PHOTO_URL_MAX: 1000,
  SCREENSHOT_DATA_URL_MAX: 450000,
  MAX_SCREENSHOTS: 4,
} as const;

export interface AppEntry {
  id: string;
  name: string;
  description: string;
  iconDataUrl: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  packageName: string;
  versionName: string;
  downloadsCount: number;
  status: 'published';
  uploaderId: string;
  uploaderName: string;
  uploaderPhoto: string;
  screenshotCount: number;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface AppScreenshot {
  id: string;
  appId: string;
  uploaderId: string;
  imageDataUrl: string;
  order: number;
  status: 'published';
  createdAt: Timestamp | null;
}

export interface UploadedApkInfo {
  fileId: string;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  extractedName: string;
  packageName: string;
  versionName: string;
  iconDataUrl: string;
  iconSource: 'manifest' | 'heuristic' | 'fallback';
  downloadUrl: string;
}
