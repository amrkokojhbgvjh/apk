import crypto from 'crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { extractApkMetadata, verifyZipSignature } from './src/server/apkParser.ts';

const PORT = Number(process.env.PORT || 3000);
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads', 'apks');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const FILE_ID_PATTERN = /^[a-zA-Z0-9_\-]+$/;
const MAX_APK_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_SINGLE_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB ceiling per chunk

interface ActiveChunkSession {
  uploadId: string;
  fileName: string;
  expectedSize: number;
  bytesWritten: number;
  nextChunkIndex: number;
  createdAt: number;
  partPath: string;
}

const activeUploads = new Map<string, ActiveChunkSession>();

// Periodically clean abandoned partial uploads (> 45 min old)
setInterval(() => {
  const cutoff = Date.now() - 45 * 60 * 1000;
  for (const [id, session] of activeUploads.entries()) {
    if (session.createdAt < cutoff) {
      try {
        if (fs.existsSync(session.partPath)) fs.unlinkSync(session.partPath);
      } catch {
        // Ignore cleanup errors
      }
      activeUploads.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

function sanitizeOriginalFilename(rawName: string): string {
  let decoded = rawName;
  try {
    const recoded = Buffer.from(rawName, 'latin1').toString('utf8');
    if (/[\u0600-\u06FF]/.test(recoded) && !/[\u0600-\u06FF]/.test(rawName)) {
      decoded = recoded;
    }
  } catch {
    // Keep original
  }
  // Preserve exact original filename & extension (.apk, .apks, .xapk, etc.) without modifying it
  const base = path.basename(decoded).replace(/[\r\n\0/\\:*?"<>|]/g, '_').trim();
  if (!base) return 'app.apk';
  if (!path.extname(base)) {
    return `${base.slice(0, 195)}.apk`;
  }
  return base.slice(0, 200);
}

function getContentTypeForFile(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.apk')) return 'application/vnd.android.package-archive';
  return 'application/octet-stream';
}

function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, _file, cb) => {
    const fileId = `apk_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    cb(null, `${fileId}.apk`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 1,
  },
});

async function finalizeApkResponse(
  apkPath: string,
  fileId: string,
  safeFileName: string,
  fileSize: number,
  res: Response
) {
  if (!verifyZipSignature(apkPath)) {
    try {
      fs.unlinkSync(apkPath);
    } catch {
      // Ignore
    }
    res.status(400).json({
      ok: false,
      error: 'الملف المحدد ليس ملف APK صالحاً. يرجى التأكد من اختيار ملف تطبيق أندرويد (.apk).',
    });
    return;
  }

  try {
    // Extract icon & metadata in read-only mode without altering a single byte of the file
    const metadata = extractApkMetadata(apkPath, safeFileName);
    const fileSha256 = await computeFileSha256(apkPath);

    const metaPath = path.join(UPLOADS_DIR, `${fileId}.meta.json`);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        fileId,
        fileName: safeFileName,
        fileSize,
        fileSha256,
        uploadedAt: new Date().toISOString(),
      }),
      'utf8'
    );

    res.json({
      ok: true,
      fileId,
      fileName: safeFileName,
      fileSize,
      fileSha256,
      extractedName: metadata.extractedName,
      packageName: metadata.packageName,
      versionName: metadata.versionName,
      iconDataUrl: metadata.iconDataUrl,
      iconSource: metadata.iconSource,
      downloadUrl: `/api/apks/${fileId}/${encodeURIComponent(safeFileName)}`,
    });
  } catch (err) {
    console.error('APK metadata extraction error:', err);
    try {
      fs.unlinkSync(apkPath);
    } catch {
      // Ignore
    }
    res.status(500).json({
      ok: false,
      error: 'تعذرت قراءة بيانات ملف التطبيق. يرجى المحاولة مرة أخرى.',
    });
  }
}

function serveUntouchedApk(req: Request, res: Response, isHeadOnly: boolean) {
  const fileId = String(req.params.fileId || '');
  if (!FILE_ID_PATTERN.test(fileId)) {
    if (isHeadOnly) {
      res.status(400).end();
    } else {
      res.status(400).json({ ok: false, error: 'معرف الملف غير صالح.' });
    }
    return;
  }

  const apkPath = path.join(UPLOADS_DIR, `${fileId}.apk`);
  if (!fs.existsSync(apkPath)) {
    if (isHeadOnly) {
      res.status(404).end();
    } else {
      res.status(404).json({ ok: false, error: 'ملف التطبيق غير موجود على الخادم حالياً.' });
    }
    return;
  }

  let downloadFileName = `${fileId}.apk`;
  let fileSha256 = '';
  const metaPath = path.join(UPLOADS_DIR, `${fileId}.meta.json`);
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
        fileName?: string;
        fileSha256?: string;
      };
      if (meta.fileName) downloadFileName = sanitizeOriginalFilename(meta.fileName);
      if (meta.fileSha256) fileSha256 = meta.fileSha256;
    } catch {
      // Fallback
    }
  }

  const stat = fs.statSync(apkPath);
  const totalSize = stat.size;
  const asciiFallback = downloadFileName.replace(/[^\x20-\x7E]/g, '_') || 'app.apk';
  const encodedUtf8 = encodeURIComponent(downloadFileName);

  // Strict untouched binary delivery headers (no-transform prevents proxy re-encoding/corruption)
  res.setHeader('Content-Type', getContentTypeForFile(downloadFileName));
  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable, no-transform');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (fileSha256) {
    res.setHeader('ETag', `"${fileSha256}"`);
    res.setHeader('X-File-SHA256', fileSha256);
  }
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`
  );

  if (isHeadOnly) {
    res.setHeader('Content-Length', String(totalSize));
    res.status(200).end();
    return;
  }

  // Support HTTP Range requests for Android Download Manager & Chrome native resumable APK downloads
  const rangeHeader = req.headers.range;
  if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
    const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
    const start = startStr ? Number(startStr) : 0;
    const end = endStr ? Math.min(Number(endStr), totalSize - 1) : totalSize - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      res.status(416).end();
      return;
    }

    const chunkLength = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', String(chunkLength));

    const rangeStream = fs.createReadStream(apkPath, { start, end });
    rangeStream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    rangeStream.pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(totalSize));
  const stream = fs.createReadStream(apkPath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'حدث خطأ أثناء تحميل الملف.' });
    }
  });
  stream.pipe(res);
}

async function startServer() {
  const app = express();

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // =========================================================================
  // Bit-for-Bit Chunked APK Upload API (up to 500MB, zero file modification)
  // =========================================================================

  app.post('/api/apks/upload/init', express.json({ limit: '100kb' }), (req: Request, res: Response) => {
    const rawName = typeof req.body?.fileName === 'string' ? req.body.fileName : 'app.apk';
    const fileSize = Number(req.body?.fileSize || 0);

    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      res.status(400).json({ ok: false, error: 'حجم ملف التطبيق غير صالح.' });
      return;
    }

    if (fileSize > MAX_APK_SIZE_BYTES) {
      res.status(413).json({
        ok: false,
        error: 'حجم ملف APK يتجاوز الحد الأقصى المسموح به (500 ميجابايت).',
      });
      return;
    }

    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const uploadId = `apk_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const safeFileName = sanitizeOriginalFilename(rawName);
    const partPath = path.join(UPLOADS_DIR, `${uploadId}.part`);

    fs.writeFileSync(partPath, Buffer.alloc(0));

    activeUploads.set(uploadId, {
      uploadId,
      fileName: safeFileName,
      expectedSize: fileSize,
      bytesWritten: 0,
      nextChunkIndex: 0,
      createdAt: Date.now(),
      partPath,
    });

    res.json({ ok: true, uploadId, fileName: safeFileName });
  });

  app.post(
    '/api/apks/upload/chunk',
    express.raw({ type: '*/*', limit: `${MAX_SINGLE_CHUNK_BYTES}` }),
    (req: Request, res: Response) => {
      const uploadId = String(req.headers['x-upload-id'] || '');
      const chunkIndex = Number(req.headers['x-chunk-index'] ?? -1);

      if (!FILE_ID_PATTERN.test(uploadId)) {
        res.status(400).json({ ok: false, error: 'معرف جلسة الرفع غير صالح.' });
        return;
      }

      const session = activeUploads.get(uploadId);
      if (!session || !fs.existsSync(session.partPath)) {
        res.status(404).json({ ok: false, error: 'انتهت جلسة الرفع. يرجى إعادة اختيار الملف.' });
        return;
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ ok: false, error: 'تم استلام جزء فارغ من الملف.' });
        return;
      }

      if (chunkIndex === session.nextChunkIndex - 1) {
        res.json({
          ok: true,
          chunkIndex,
          bytesWritten: session.bytesWritten,
        });
        return;
      }

      if (chunkIndex !== session.nextChunkIndex) {
        res.status(409).json({
          ok: false,
          error: 'ترتيب أجزاء الملف غير متزامن. يرجى إعادة المحاولة.',
        });
        return;
      }

      if (session.bytesWritten + req.body.length > MAX_APK_SIZE_BYTES) {
        try {
          fs.unlinkSync(session.partPath);
        } catch {
          // Ignore
        }
        activeUploads.delete(uploadId);
        res.status(413).json({
          ok: false,
          error: 'تجاوز الملف الحد الأقصى المسموح به للحجم.',
        });
        return;
      }

      fs.appendFileSync(session.partPath, req.body);
      session.bytesWritten += req.body.length;
      session.nextChunkIndex += 1;

      res.json({
        ok: true,
        chunkIndex,
        bytesWritten: session.bytesWritten,
      });
    }
  );

  app.post('/api/apks/upload/complete', express.json({ limit: '100kb' }), async (req: Request, res: Response) => {
    const uploadId = String(req.body?.uploadId || '');
    if (!FILE_ID_PATTERN.test(uploadId)) {
      res.status(400).json({ ok: false, error: 'معرف الرفع غير صالح.' });
      return;
    }

    const session = activeUploads.get(uploadId);
    if (!session || !fs.existsSync(session.partPath)) {
      res.status(404).json({ ok: false, error: 'لم يتم العثور على الملف المرفوع. يرجى إعادة المحاولة.' });
      return;
    }

    activeUploads.delete(uploadId);

    const apkPath = path.join(UPLOADS_DIR, `${uploadId}.apk`);
    try {
      fs.renameSync(session.partPath, apkPath);
    } catch {
      res.status(500).json({ ok: false, error: 'تعذر حفظ ملف التطبيق على الخادم.' });
      return;
    }

    const actualSize = fs.statSync(apkPath).size;
    await finalizeApkResponse(apkPath, uploadId, session.fileName, actualSize, res);
  });

  app.post('/api/apks/upload/abort', express.json({ limit: '100kb' }), (req: Request, res: Response) => {
    const uploadId = String(req.body?.uploadId || '');
    if (FILE_ID_PATTERN.test(uploadId)) {
      const session = activeUploads.get(uploadId);
      if (session) {
        try {
          if (fs.existsSync(session.partPath)) fs.unlinkSync(session.partPath);
        } catch {
          // Ignore
        }
        activeUploads.delete(uploadId);
      }
    }
    res.json({ ok: true });
  });

  // Single-shot upload fallback
  app.post('/api/apks/upload', upload.single('apk'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ ok: false, error: 'لم يتم استلام أي ملف APK.' });
      return;
    }
    const fileId = path.basename(req.file.filename, '.apk');
    const safeFileName = sanitizeOriginalFilename(req.file.originalname);
    await finalizeApkResponse(req.file.path, fileId, safeFileName, req.file.size, res);
  });

  // Authenticated metadata check for sliced client-side Blob download
  app.get('/api/apks/:fileId/info', (req: Request, res: Response) => {
    const fileId = String(req.params.fileId || '');
    if (!FILE_ID_PATTERN.test(fileId)) {
      res.status(400).json({ ok: false, error: 'معرف الملف غير صالح.' });
      return;
    }

    const apkPath = path.join(UPLOADS_DIR, `${fileId}.apk`);
    if (!fs.existsSync(apkPath)) {
      res.status(404).json({ ok: false, error: 'ملف التطبيق غير موجود على الخادم حالياً.' });
      return;
    }

    const stat = fs.statSync(apkPath);
    let fileName = `${fileId}.apk`;
    let fileSha256 = '';
    const metaPath = path.join(UPLOADS_DIR, `${fileId}.meta.json`);
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
          fileName?: string;
          fileSha256?: string;
        };
        if (meta.fileName) fileName = sanitizeOriginalFilename(meta.fileName);
        if (meta.fileSha256) fileSha256 = meta.fileSha256;
      } catch {
        // Fallback
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      fileId,
      fileName,
      fileSize: stat.size,
      fileSha256,
    });
  });

  // Exact untouched binary slice endpoint (bypasses Cloud Run 32MB limit & Android DownloadManager IAP HTML redirect)
  app.get('/api/apks/:fileId/slice', (req: Request, res: Response) => {
    const fileId = String(req.params.fileId || '');
    if (!FILE_ID_PATTERN.test(fileId)) {
      res.status(400).json({ ok: false, error: 'معرف الملف غير صالح.' });
      return;
    }

    const apkPath = path.join(UPLOADS_DIR, `${fileId}.apk`);
    if (!fs.existsSync(apkPath)) {
      res.status(404).json({ ok: false, error: 'ملف التطبيق غير موجود على الخادم حالياً.' });
      return;
    }

    const totalSize = fs.statSync(apkPath).size;
    const start = Number(req.query.start ?? 0);
    const requestedEnd = Number(req.query.end ?? totalSize - 1);
    const end = Math.min(requestedEnd, totalSize - 1);

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      start >= totalSize ||
      end - start + 1 > MAX_SINGLE_CHUNK_BYTES
    ) {
      res.status(400).json({ ok: false, error: 'نطاق تحميل الملف غير صالح.' });
      return;
    }

    const byteLength = end - start + 1;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(byteLength));
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const sliceStream = fs.createReadStream(apkPath, { start, end });
    sliceStream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'حدث خطأ أثناء قراءة جزء من الملف.' });
      }
    });
    sliceStream.pipe(res);
  });

  // Bit-for-bit untouched APK download (both /api/apks/:fileId and /api/apks/:fileId/:downloadName)
  app.get('/api/apks/:fileId', (req: Request, res: Response) => serveUntouchedApk(req, res, false));
  app.get('/api/apks/:fileId/:downloadName', (req: Request, res: Response) =>
    serveUntouchedApk(req, res, false)
  );
  app.head('/api/apks/:fileId', (req: Request, res: Response) => serveUntouchedApk(req, res, true));
  app.head('/api/apks/:fileId/:downloadName', (req: Request, res: Response) =>
    serveUntouchedApk(req, res, true)
  );

  // Clean up APK binary
  app.delete('/api/apks/:fileId', (req: Request, res: Response) => {
    const fileId = String(req.params.fileId || '');
    if (!FILE_ID_PATTERN.test(fileId)) {
      res.status(400).json({ ok: false, error: 'معرف الملف غير صالح.' });
      return;
    }

    const apkPath = path.join(UPLOADS_DIR, `${fileId}.apk`);
    const metaPath = path.join(UPLOADS_DIR, `${fileId}.meta.json`);
    try {
      if (fs.existsSync(apkPath)) fs.unlinkSync(apkPath);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    } catch {
      // Ignore cleanup errors
    }
    res.json({ ok: true });
  });

  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ ok: false, error: 'حجم ملف APK كبير جداً.' });
        return;
      }
      res.status(400).json({ ok: false, error: `خطأ في رفع الملف: ${err.message}` });
      return;
    }
    const message = err instanceof Error ? err.message : 'حدث خطأ غير متوقع في الخادم.';
    res.status(400).json({ ok: false, error: message });
  });

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'المسار المطلوب غير موجود.' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`APK Store server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
