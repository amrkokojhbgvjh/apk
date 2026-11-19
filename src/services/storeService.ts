import { signInWithPopup, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from '../firebase';
import { SCHEMA_LIMITS } from '../types/store';
import type { AppEntry, AppScreenshot, UploadedApkInfo } from '../types/store';
import { normalizeIconDataUrl } from '../utils/imageUtils';

const CHUNK_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 3;

const inFlightProfileSync = new Map<string, Promise<void>>();

function generateSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, SCHEMA_LIMITS.ID_MAX);
}

export function getExactApkDownloadUrl(fileId: string, fileName: string): string {
  return `/api/apks/${encodeURIComponent(fileId)}/${encodeURIComponent(fileName)}`;
}

const DOWNLOAD_SLICE_BYTES = 4 * 1024 * 1024;

export async function downloadExactApkFile(
  app: AppEntry,
  onProgress?: (percent: number) => void
): Promise<void> {
  onProgress?.(1);

  const infoRes = await fetch(`/api/apks/${encodeURIComponent(app.fileId)}/info`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  });

  const infoText = await infoRes.text();
  let infoJson: Record<string, unknown> | null = null;
  try {
    infoJson = JSON.parse(infoText) as Record<string, unknown>;
  } catch {
    throw new Error('تعذر الوصول إلى ملف التطبيق على الخادم. يرجى المحاولة مرة أخرى.');
  }

  if (!infoRes.ok || infoJson?.ok !== true) {
    const serverErr =
      typeof infoJson?.error === 'string'
        ? infoJson.error
        : 'ملف التطبيق غير متوفر حالياً على الخادم.';
    throw new Error(serverErr);
  }

  const totalSize = Number(infoJson.fileSize || 0);
  const exactFileName =
    typeof infoJson.fileName === 'string' && infoJson.fileName.trim()
      ? infoJson.fileName.trim()
      : app.fileName || `${app.name}.apk`;

  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    throw new Error('ملف التطبيق غير صالح للتحميل.');
  }

  const slices: ArrayBuffer[] = [];
  let downloadedBytes = 0;

  for (let start = 0; start < totalSize; start += DOWNLOAD_SLICE_BYTES) {
    const end = Math.min(start + DOWNLOAD_SLICE_BYTES - 1, totalSize - 1);
    const expectedLen = end - start + 1;

    let sliceBuf: ArrayBuffer | null = null;
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
      try {
        const res = await fetch(
          `/api/apks/${encodeURIComponent(app.fileId)}/slice?start=${start}&end=${end}`,
          {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
          }
        );

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (!res.ok || contentType.includes('text/html') || contentType.includes('application/json')) {
          throw new Error('استجابة غير صالحة أثناء تحميل جزء من ملف التطبيق.');
        }

        const buf = await res.arrayBuffer();
        if (buf.byteLength !== expectedLen) {
          throw new Error('حجم الجزء المستلم غير مكتمل.');
        }

        if (start === 0) {
          const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
          if (
            head.length < 4 ||
            head[0] !== 0x50 ||
            head[1] !== 0x4b ||
            (head[2] !== 0x03 && head[2] !== 0x05)
          ) {
            throw new Error('الملف المستلم ليس بصيغة APK صالحة.');
          }
        }

        sliceBuf = buf;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_CHUNK_RETRIES) {
          await new Promise((r) => setTimeout(r, 600 * attempt));
        }
      }
    }

    if (!sliceBuf) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error('انقطع التحميل. يرجى المحاولة مرة أخرى.');
    }

    slices.push(sliceBuf);
    downloadedBytes += sliceBuf.byteLength;
    const pct = Math.min(99, Math.max(2, Math.round((downloadedBytes / totalSize) * 99)));
    onProgress?.(pct);
  }

  if (downloadedBytes !== totalSize) {
    throw new Error('لم يكتمل تحميل الملف بالكامل. يرجى المحاولة مرة أخرى.');
  }

  const mimeType = exactFileName.toLowerCase().endsWith('.apk')
    ? 'application/vnd.android.package-archive'
    : 'application/octet-stream';
  const apkBlob = new Blob(slices, { type: mimeType });
  const blobUrl = URL.createObjectURL(apkBlob);

  onProgress?.(100);

  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = exactFileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 60_000);

  void trackAppDownload(app.id);
}

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  await ensureUserProfile(result.user);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export function ensureUserProfile(user: User): Promise<void> {
  const existingPromise = inFlightProfileSync.get(user.uid);
  if (existingPromise) return existingPromise;

  const task = (async () => {
    const userPath = `users/${user.uid}`;
    const userRef = doc(db, 'users', user.uid);
    const statsRef = doc(db, 'storeStats', 'summary');

    try {
      const existingSnap = await getDoc(userRef);
      const safeDisplayName = (user.displayName || 'مستخدم').trim().slice(0, SCHEMA_LIMITS.UPLOADER_NAME_MAX);
      const safeEmail = (user.email || '').trim().slice(0, 254);
      const safePhoto = (user.photoURL || '').trim().slice(0, SCHEMA_LIMITS.PHOTO_URL_MAX);

      if (!existingSnap.exists()) {
        const statsSnap = await getDoc(statsRef);
        const batch = writeBatch(db);

        batch.set(userRef, {
          uid: user.uid,
          displayName: safeDisplayName,
          email: safeEmail,
          photoURL: safePhoto,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        if (!statsSnap.exists()) {
          batch.set(statsRef, {
            registeredUsersCount: 1,
            updatedAt: serverTimestamp(),
          });
        } else {
          batch.update(statsRef, {
            registeredUsersCount: increment(1),
            updatedAt: serverTimestamp(),
          });
        }

        await batch.commit();
      } else {
        const data = existingSnap.data();
        if (data.displayName !== safeDisplayName || data.photoURL !== safePhoto) {
          await updateDoc(userRef, {
            displayName: safeDisplayName,
            photoURL: safePhoto,
            updatedAt: serverTimestamp(),
          });
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, userPath);
    }
  })().finally(() => {
    inFlightProfileSync.delete(user.uid);
  });

  inFlightProfileSync.set(user.uid, task);
  return task;
}

export function subscribeStoreStats(
  onUpdate: (registeredUsersCount: number) => void,
  onError?: (error: Error) => void
): () => void {
  const statsPath = 'storeStats/summary';
  return onSnapshot(
    doc(db, 'storeStats', 'summary'),
    (snap) => {
      if (snap.exists()) {
        const count = Number(snap.data().registeredUsersCount ?? 0);
        onUpdate(Number.isFinite(count) ? count : 0);
      } else {
        onUpdate(0);
      }
    },
    (error) => {
      if (onError) onError(error);
      try {
        handleFirestoreError(error, OperationType.GET, statsPath);
      } catch {
        // Logged via handleFirestoreError
      }
    }
  );
}

export function subscribePublishedApps(
  onUpdate: (apps: AppEntry[]) => void,
  onError?: (error: Error) => void
): () => void {
  const appsPath = 'apps';
  const q = query(collection(db, 'apps'), where('status', '==', 'published'));

  return onSnapshot(
    q,
    (snapshot) => {
      const list: AppEntry[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          name: String(data.name || ''),
          description: String(data.description || ''),
          iconDataUrl: String(data.iconDataUrl || ''),
          fileId: String(data.fileId || ''),
          fileName: String(data.fileName || ''),
          fileSize: Number(data.fileSize || 0),
          fileSha256: String(data.fileSha256 || ''),
          packageName: String(data.packageName || ''),
          versionName: String(data.versionName || ''),
          downloadsCount: Number(data.downloadsCount || 0),
          status: 'published',
          uploaderId: String(data.uploaderId || ''),
          uploaderName: String(data.uploaderName || 'مستخدم'),
          uploaderPhoto: String(data.uploaderPhoto || ''),
          screenshotCount: Number(data.screenshotCount || 0),
          createdAt: data.createdAt ?? null,
          updatedAt: data.updatedAt ?? null,
        };
      });

      list.sort((a, b) => {
        const tA = a.createdAt ? a.createdAt.toMillis() : Date.now();
        const tB = b.createdAt ? b.createdAt.toMillis() : Date.now();
        return tB - tA;
      });

      onUpdate(list);
    },
    (error) => {
      if (onError) onError(error);
      try {
        handleFirestoreError(error, OperationType.LIST, appsPath);
      } catch {
        // Logged via handleFirestoreError
      }
    }
  );
}

async function parseJsonResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (res.status === 413) {
      throw new Error('حجم الطلب تجاوز حد الخادم. يرجى المحاولة مرة أخرى.');
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error('الخادم مشغول حالياً. يرجى المحاولة بعد لحظات.');
    }
    throw new Error(`تعذر الاتصال بخادم رفع التطبيقات (رمز ${res.status}). يرجى المحاولة مرة أخرى.`);
  }
}

async function verifyClientZipHeader(file: File): Promise<boolean> {
  try {
    const headerBuf = await file.slice(0, 4).arrayBuffer();
    const bytes = new Uint8Array(headerBuf);
    return (
      bytes.length === 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05)
    );
  } catch {
    return true;
  }
}

function sendBinaryChunk(params: {
  uploadId: string;
  chunkIndex: number;
  chunkBlob: Blob;
  signal?: AbortSignal;
  onChunkProgress: (loadedBytes: number) => void;
}): Promise<{ ok: boolean; bytesWritten: number }> {
  const { uploadId, chunkIndex, chunkBlob, signal, onChunkProgress } = params;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();

    const onAbort = () => {
      xhr.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onChunkProgress(event.loaded);
      }
    });

    xhr.addEventListener('load', () => {
      signal?.removeEventListener('abort', onAbort);
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(`استجابة غير متوقعة أثناء رفع الجزء (رمز ${xhr.status}).`));
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300 && payload?.ok === true) {
        onChunkProgress(chunkBlob.size);
        resolve({
          ok: true,
          bytesWritten: Number(payload.bytesWritten || 0),
        });
      } else {
        const msg =
          typeof payload?.error === 'string'
            ? payload.error
            : `فشل رفع جزء من الملف (رمز ${xhr.status}).`;
        reject(new Error(msg));
      }
    });

    xhr.addEventListener('error', () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('انقطع الاتصال بالشبكة أثناء رفع الملف.'));
    });

    xhr.addEventListener('timeout', () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('انتهت مهلة الاتصال أثناء رفع الجزء.'));
    });

    xhr.open('POST', '/api/apks/upload/chunk');
    xhr.timeout = 60_000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Id', uploadId);
    xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
    xhr.send(chunkBlob);
  });
}

async function abortServerUploadSession(uploadId: string): Promise<void> {
  if (!uploadId) return;
  try {
    await fetch('/api/apks/upload/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
  } catch {
    // Non-blocking cleanup
  }
}

export async function uploadApkToServer(
  file: File,
  onProgress: (percent: number, phase: 'uploading' | 'extracting') => void,
  signal?: AbortSignal
): Promise<UploadedApkInfo> {
  const isZip = await verifyClientZipHeader(file);
  if (!isZip) {
    throw new Error('الملف المحدد ليس ملف APK صالحاً. يرجى اختيار ملف تطبيق أندرويد (.apk).');
  }

  onProgress(1, 'uploading');

  const initRes = await fetch('/api/apks/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
    }),
    signal,
  });

  const initJson = await parseJsonResponse(initRes);
  if (!initRes.ok || initJson.ok !== true || typeof initJson.uploadId !== 'string') {
    throw new Error(
      typeof initJson.error === 'string'
        ? initJson.error
        : 'تعذر بدء جلسة رفع التطبيق. يرجى المحاولة مرة أخرى.'
    );
  }

  const uploadId = initJson.uploadId;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));

  try {
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const start = chunkIndex * CHUNK_SIZE_BYTES;
      const end = Math.min(start + CHUNK_SIZE_BYTES, file.size);
      const chunkBlob = file.slice(start, end);

      let attempt = 0;
      let chunkDone = false;
      let lastError: unknown = null;

      while (attempt < MAX_CHUNK_RETRIES && !chunkDone) {
        attempt += 1;
        try {
          await sendBinaryChunk({
            uploadId,
            chunkIndex,
            chunkBlob,
            signal,
            onChunkProgress: (loadedInChunk) => {
              const totalLoaded = Math.min(file.size, start + loadedInChunk);
              const pct = Math.min(95, Math.max(2, Math.round((totalLoaded / file.size) * 95)));
              onProgress(pct, 'uploading');
            },
          });
          chunkDone = true;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          lastError = err;
          if (attempt < MAX_CHUNK_RETRIES) {
            await new Promise((r) => setTimeout(r, 700 * attempt));
          }
        }
      }

      if (!chunkDone) {
        throw lastError instanceof Error
          ? lastError
          : new Error('فشل رفع ملف التطبيق بسبب انقطاع الاتصال. يرجى المحاولة مرة أخرى.');
      }
    }

    onProgress(97, 'extracting');
    const completeRes = await fetch('/api/apks/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
      signal,
    });

    const completeJson = await parseJsonResponse(completeRes);
    if (!completeRes.ok || completeJson.ok !== true) {
      throw new Error(
        typeof completeJson.error === 'string'
          ? completeJson.error
          : 'تعذر تجهيز ملف التطبيق واستخراج أيقونته.'
      );
    }

    onProgress(100, 'extracting');

    const finalFileName = String(completeJson.fileName || file.name);
    const finalFileId = String(completeJson.fileId || uploadId);

    return {
      fileId: finalFileId,
      fileName: finalFileName,
      fileSize: Number(completeJson.fileSize || file.size),
      fileSha256: String(completeJson.fileSha256 || ''),
      extractedName: String(completeJson.extractedName || ''),
      packageName: String(completeJson.packageName || ''),
      versionName: String(completeJson.versionName || ''),
      iconDataUrl: String(completeJson.iconDataUrl || ''),
      iconSource: (completeJson.iconSource as UploadedApkInfo['iconSource']) || 'fallback',
      downloadUrl: String(
        completeJson.downloadUrl || getExactApkDownloadUrl(finalFileId, finalFileName)
      ),
    };
  } catch (err) {
    void abortServerUploadSession(uploadId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('تم إلغاء عملية رفع التطبيق.');
    }
    throw err;
  }
}

export async function cancelServerApkUpload(fileId: string): Promise<void> {
  if (!fileId) return;
  try {
    await fetch(`/api/apks/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  } catch {
    // Non-blocking cleanup
  }
}

export async function publishAppToStore(params: {
  user: User;
  uploadedApk: UploadedApkInfo;
  customName: string;
  description: string;
  screenshots: string[];
}): Promise<string> {
  const { user, uploadedApk, customName, description, screenshots } = params;

  await ensureUserProfile(user);

  const appId = generateSafeId('app');
  const appPath = `apps/${appId}`;
  const fallbackName = (
    customName.trim() ||
    uploadedApk.extractedName ||
    uploadedApk.fileName.replace(/\.apk$/i, '') ||
    'تطبيق أندرويد'
  ).slice(0, SCHEMA_LIMITS.NAME_MAX);

  const normalizedIcon = await normalizeIconDataUrl(uploadedApk.iconDataUrl, fallbackName);
  const finalDesc = description.trim().slice(0, SCHEMA_LIMITS.DESCRIPTION_MAX);
  const safeScreenshots = screenshots
    .filter((s) => s.length > 0 && s.length <= SCHEMA_LIMITS.SCREENSHOT_DATA_URL_MAX)
    .slice(0, SCHEMA_LIMITS.MAX_SCREENSHOTS);

  try {
    const batch = writeBatch(db);
    const appRef = doc(db, 'apps', appId);

    batch.set(appRef, {
      id: appId,
      name: fallbackName,
      description: finalDesc,
      iconDataUrl: normalizedIcon,
      fileId: uploadedApk.fileId.slice(0, SCHEMA_LIMITS.ID_MAX),
      fileName: uploadedApk.fileName.slice(0, SCHEMA_LIMITS.FILE_NAME_MAX),
      fileSize: Math.max(1, Math.min(Math.round(uploadedApk.fileSize), SCHEMA_LIMITS.FILE_SIZE_MAX)),
      fileSha256: uploadedApk.fileSha256.slice(0, SCHEMA_LIMITS.FILE_SHA256_MAX),
      packageName: uploadedApk.packageName.slice(0, SCHEMA_LIMITS.PACKAGE_NAME_MAX),
      versionName: uploadedApk.versionName.slice(0, SCHEMA_LIMITS.VERSION_NAME_MAX),
      downloadsCount: 0,
      status: 'published',
      uploaderId: user.uid,
      uploaderName: (user.displayName || 'مستخدم').trim().slice(0, SCHEMA_LIMITS.UPLOADER_NAME_MAX),
      uploaderPhoto: (user.photoURL || '').trim().slice(0, SCHEMA_LIMITS.PHOTO_URL_MAX),
      screenshotCount: safeScreenshots.length,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    safeScreenshots.forEach((imageDataUrl, idx) => {
      const shotId = `shot_${idx}_${Date.now()}`;
      const shotRef = doc(db, 'apps', appId, 'screenshots', shotId);
      batch.set(shotRef, {
        id: shotId,
        appId,
        uploaderId: user.uid,
        imageDataUrl,
        order: idx,
        status: 'published',
        createdAt: serverTimestamp(),
      });
    });

    await batch.commit();
    return appId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, appPath);
  }
}

export async function updatePublishedApp(params: {
  user: User;
  app: AppEntry;
  name: string;
  description: string;
  keptScreenshots: AppScreenshot[];
  removedScreenshotIds: string[];
  addedScreenshotDataUrls: string[];
  replacementApk?: UploadedApkInfo | null;
}): Promise<void> {
  const {
    user,
    app,
    name,
    description,
    keptScreenshots,
    removedScreenshotIds,
    addedScreenshotDataUrls,
    replacementApk,
  } = params;

  const appPath = `apps/${app.id}`;
  const finalName = (
    name.trim() ||
    replacementApk?.extractedName ||
    app.name ||
    'تطبيق أندرويد'
  ).slice(0, SCHEMA_LIMITS.NAME_MAX);
  const finalDesc = description.trim().slice(0, SCHEMA_LIMITS.DESCRIPTION_MAX);

  const safeNewShots = addedScreenshotDataUrls
    .filter((s) => s.length > 0 && s.length <= SCHEMA_LIMITS.SCREENSHOT_DATA_URL_MAX)
    .slice(0, Math.max(0, SCHEMA_LIMITS.MAX_SCREENSHOTS - keptScreenshots.length));

  const newTotalShots = Math.min(
    SCHEMA_LIMITS.MAX_SCREENSHOTS,
    keptScreenshots.length + safeNewShots.length
  );

  try {
    const batch = writeBatch(db);
    const appRef = doc(db, 'apps', app.id);

    const updatePayload: Record<string, unknown> = {
      name: finalName,
      description: finalDesc,
      screenshotCount: newTotalShots,
      updatedAt: serverTimestamp(),
    };

    if (replacementApk) {
      const normalizedIcon = await normalizeIconDataUrl(replacementApk.iconDataUrl, finalName);
      updatePayload.fileId = replacementApk.fileId.slice(0, SCHEMA_LIMITS.ID_MAX);
      updatePayload.fileName = replacementApk.fileName.slice(0, SCHEMA_LIMITS.FILE_NAME_MAX);
      updatePayload.fileSize = Math.max(
        1,
        Math.min(Math.round(replacementApk.fileSize), SCHEMA_LIMITS.FILE_SIZE_MAX)
      );
      updatePayload.fileSha256 = replacementApk.fileSha256.slice(0, SCHEMA_LIMITS.FILE_SHA256_MAX);
      updatePayload.iconDataUrl = normalizedIcon;
      updatePayload.packageName = replacementApk.packageName.slice(0, SCHEMA_LIMITS.PACKAGE_NAME_MAX);
      updatePayload.versionName = replacementApk.versionName.slice(0, SCHEMA_LIMITS.VERSION_NAME_MAX);
    }

    batch.update(appRef, updatePayload);

    for (const removedId of removedScreenshotIds) {
      batch.delete(doc(db, 'apps', app.id, 'screenshots', removedId));
    }

    const baseOrder = keptScreenshots.length;
    safeNewShots.forEach((imageDataUrl, idx) => {
      const shotId = `shot_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
      const shotRef = doc(db, 'apps', app.id, 'screenshots', shotId);
      batch.set(shotRef, {
        id: shotId,
        appId: app.id,
        uploaderId: user.uid,
        imageDataUrl,
        order: Math.min(3, baseOrder + idx),
        status: 'published',
        createdAt: serverTimestamp(),
      });
    });

    await batch.commit();

    if (replacementApk && app.fileId && replacementApk.fileId !== app.fileId) {
      void cancelServerApkUpload(app.fileId);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, appPath);
  }
}

export async function fetchAppScreenshots(appId: string): Promise<AppScreenshot[]> {
  const path = `apps/${appId}/screenshots`;
  try {
    const q = query(collection(db, 'apps', appId, 'screenshots'), where('status', '==', 'published'));
    const snap = await getDocs(q);
    const list: AppScreenshot[] = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        appId: String(data.appId || appId),
        uploaderId: String(data.uploaderId || ''),
        imageDataUrl: String(data.imageDataUrl || ''),
        order: Number(data.order || 0),
        status: 'published',
        createdAt: data.createdAt ?? null,
      };
    });
    list.sort((a, b) => a.order - b.order);
    return list;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function trackAppDownload(appId: string): Promise<void> {
  if (!auth.currentUser || !auth.currentUser.emailVerified) {
    return;
  }
  try {
    await updateDoc(doc(db, 'apps', appId), {
      downloadsCount: increment(1),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    console.warn('Download counter update skipped:', error);
  }
}

export async function deletePublishedApp(app: AppEntry): Promise<void> {
  const appPath = `apps/${app.id}`;
  try {
    const shotsQuery = query(collection(db, 'apps', app.id, 'screenshots'), where('status', '==', 'published'));
    const shotsSnap = await getDocs(shotsQuery);
    for (const shotDoc of shotsSnap.docs) {
      await deleteDoc(shotDoc.ref);
    }

    await deleteDoc(doc(db, 'apps', app.id));
    await cancelServerApkUpload(app.fileId);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, appPath);
  }
}
