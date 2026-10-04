const {
  DEFAULT_PLACEHOLDER_REASON,
  evaluateReportedSize,
  finiteNumber,
  isReusableFileDownload,
  needsPlaceholder,
  resolutionFields,
} = require("../../domain/course-fetch/course-file-policy");

class CourseFileTransferService {
  constructor({
    client,
    downloadMode,
    emitTransfer = () => {},
    fileStore,
    filenameFromContentDisposition,
    filenameFromUrl,
    isOpaqueFilename,
    logError = () => {},
    logInfo = () => {},
    manifest,
    previousDownloadsBySource = new Map(),
    resolveUrl,
    reuseValidatedCache = false,
    streamResponse,
  }) {
    if (!client) throw new TypeError("CourseFileTransferService requires a client");
    if (!fileStore) throw new TypeError("CourseFileTransferService requires a fileStore");
    if (!manifest) throw new TypeError("CourseFileTransferService requires a manifest");
    if (!streamResponse) throw new TypeError("CourseFileTransferService requires streamResponse");
    this.client = client;
    this.downloadMode = downloadMode;
    this.emitTransfer = emitTransfer;
    this.fileStore = fileStore;
    this.filenameFromContentDisposition = filenameFromContentDisposition;
    this.filenameFromUrl = filenameFromUrl;
    this.isOpaqueFilename = isOpaqueFilename;
    this.logError = logError;
    this.logInfo = logInfo;
    this.manifest = manifest;
    this.previousDownloadsBySource = previousDownloadsBySource;
    this.resolveUrl = resolveUrl;
    this.reuseValidatedCache = reuseValidatedCache;
    this.streamResponse = streamResponse;
  }

  prepare(file) {
    const url = this.resolveUrl(file.url);
    const sourceUrl = file.sourceUrl ? this.resolveUrl(file.sourceUrl) : url;
    const prepared = {
      ...file,
      fileName: file.fileName || file.name || this.filenameFromUrl(url) || "file",
      sourceUrl,
      url,
    };
    if (file.uiContext) {
      Object.defineProperty(prepared, "uiContext", {
        value: file.uiContext,
        enumerable: false,
      });
    }
    return prepared;
  }

  sizeFields(file, actualSize, label, allowMismatch) {
    const evaluation = evaluateReportedSize({
      actualSize,
      allowMismatch,
      file,
      fileName: file.fileName,
      label,
    });
    if (evaluation.warning) this.manifest.warnings.push(evaluation.warning);
    return evaluation.fields;
  }

  usesPlaceholder(file) {
    return needsPlaceholder(this.downloadMode, file);
  }

  writePlaceholder(file, directory, label, reason = DEFAULT_PLACEHOLDER_REASON) {
    const originalFileName = file.fileName;
    let outputPath = this.fileStore.preferredPath(
      directory,
      `${originalFileName}.placeholder.json`
    );
    const relativePath = this.fileStore.relativePath(outputPath);
    const sameRunRecord = this.manifest.downloads.find(
      (item) =>
        item.placeholder === true &&
        item.path === relativePath &&
        item.sourceUrl === file.sourceUrl
    );
    if (sameRunRecord) {
      this.manifest.downloads.push({ ...sameRunRecord, label, duplicateReference: true });
      return outputPath;
    }
    if (this.manifest.downloads.some((item) => item.path === relativePath)) {
      outputPath = this.fileStore.uniquePath(
        directory,
        `${originalFileName}.placeholder.json`
      );
    }
    const remoteSize = finiteNumber(file.fileSize);
    const metadata = {
      schemaVersion: 1,
      placeholder: true,
      reason,
      label,
      originalFileName,
      mimeType: file.mimeType || null,
      remoteSize,
      sourceUrl: file.sourceUrl,
      generatedAt: this.manifest.generatedAt,
    };
    this.fileStore.writeText(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const size = this.fileStore.fileSize(outputPath);
    this.manifest.downloads.push({
      label,
      fileName: this.fileStore.baseName(outputPath),
      originalFileName,
      path: this.fileStore.relativePath(outputPath),
      size,
      expectedSize: null,
      remoteSize,
      contentType: file.mimeType || null,
      sourceUrl: file.sourceUrl,
      sha256: this.fileStore.hashFile(outputPath),
      integrityVerified: true,
      placeholder: true,
      placeholderReason: reason,
    });
    this.manifest.transfer.placeholderFiles += 1;
    this.emitTransfer("placeholder", outputPath, size, label);
    this.logInfo(
      `placeholder ${this.fileStore.displayPath(outputPath)} (${file.mimeType || "unknown type"})`
    );
    return outputPath;
  }

  writeUnresolved(file, directory, label, error, diagnostics = []) {
    const originalFileName = file.fileName;
    const outputPath = this.fileStore.uniquePath(
      directory,
      `${originalFileName}.unresolved.json`
    );
    const metadata = {
      schemaVersion: 1,
      unresolved: true,
      reason:
        "The direct attachment URL failed and the authenticated UI did not expose a verified replacement URL",
      error: error.message,
      diagnostics,
      label,
      originalFileName,
      sourceUrl: file.sourceUrl,
      checkedAt: this.manifest.generatedAt,
    };
    this.fileStore.writeText(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const size = this.fileStore.fileSize(outputPath);
    this.manifest.downloads.push({
      label,
      fileName: this.fileStore.baseName(outputPath),
      originalFileName,
      path: this.fileStore.relativePath(outputPath),
      size,
      sourceUrl: file.sourceUrl,
      sha256: this.fileStore.hashFile(outputPath),
      integrityVerified: true,
      unresolved: true,
      linkOnly: true,
      error: error.message,
    });
    this.manifest.transfer.unresolvedFiles += 1;
    this.manifest.errors.push({
      label,
      fileName: originalFileName,
      url: file.sourceUrl,
      error:
        `${error.message}; authenticated UI resolution did not produce a working Blackboard URL`,
    });
    this.emitTransfer("unresolved", outputPath, size, label);
    this.logError(`UNRESOLVED ${label}: ${originalFileName}: ${error.message}`);
    return outputPath;
  }

  recordFailure(file, label, error, { deferred = false } = {}) {
    if (!deferred) {
      this.manifest.errors.push({
        label,
        fileName: file.fileName,
        url: file.sourceUrl,
        error: error.message,
      });
    }
    this.logError(`${deferred ? "DEFERRED" : "FAILED"} ${label}: ${file.fileName}: ${error.message}`);
  }

  recordReuse(file, label, previous, previousPath, size, hash, sizeFields, kind) {
    this.manifest.downloads.push({
      label,
      fileName: this.fileStore.baseName(previousPath),
      path: this.fileStore.relativePath(previousPath),
      size,
      ...sizeFields,
      contentType: previous.contentType || file.mimeType || null,
      sourceUrl: file.sourceUrl,
      finalUrl: previous.finalUrl || file.url,
      ...resolutionFields(file),
      etag: previous.etag || null,
      lastModified: previous.lastModified || null,
      sha256: hash,
      integrityVerified: true,
      skipped: true,
      cacheValidated: true,
      ...(kind === "reused" ? { cacheValidation: "local SHA-256" } : {}),
    });
    this.manifest.transfer.reusedFiles += 1;
    this.manifest.transfer.reusedBytes += size;
    this.emitTransfer(kind, previousPath, size, label);
    this.logInfo(
      `${kind === "reused" ? "reused validated" : "validated cached"} ` +
        `${this.fileStore.displayPath(previousPath)} (${size} bytes)`
    );
    return previousPath;
  }

  async transfer(file, directory, label, options = {}) {
    if (this.usesPlaceholder(file)) {
      return this.writePlaceholder(file, directory, label);
    }

    let temporaryPath = null;
    try {
      const previousRecord =
        this.previousDownloadsBySource.get(file.url) ||
        this.previousDownloadsBySource.get(file.sourceUrl);
      const previous = isReusableFileDownload(previousRecord) ? previousRecord : null;
      const previousPath = this.fileStore.previousLocalPath(previous);
      if (this.reuseValidatedCache && previousPath && previous?.sha256) {
        const size = this.fileStore.fileSize(previousPath);
        const hash = this.fileStore.hashFile(previousPath);
        if (hash === previous.sha256) {
          return this.recordReuse(
            file,
            label,
            previous,
            previousPath,
            size,
            hash,
            this.sizeFields(file, size, label, options.allowSizeMismatch),
            "reused"
          );
        }
      }

      const headers = {
        Cookie: this.client.cookieHeaderFor(file.url),
        "User-Agent": "Mozilla/5.0",
      };
      if (previousPath && previous?.etag) headers["If-None-Match"] = previous.etag;
      if (previousPath && previous?.lastModified) {
        headers["If-Modified-Since"] = previous.lastModified;
      }

      const response = await this.client.request(
        file.url,
        { redirect: "follow", headers },
        `file ${file.fileName}`
      );

      if (response.status === 304 && previousPath) {
        const size = this.fileStore.fileSize(previousPath);
        const sizeFields = this.sizeFields(file, size, label, options.allowSizeMismatch);
        const hash = this.fileStore.hashFile(previousPath);
        if (previous.sha256 && hash !== previous.sha256) {
          throw new Error("Cached file failed its SHA-256 integrity check");
        }
        return this.recordReuse(
          file,
          label,
          previous,
          previousPath,
          size,
          hash,
          sizeFields,
          "cached"
        );
      }

      const contentType = response.headers.get("content-type") || "";
      const finalUrl = response.url || file.url;
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const dispositionFilename = this.filenameFromContentDisposition(
        response.headers.get("content-disposition")
      );
      if (dispositionFilename && this.isOpaqueFilename(file.fileName)) {
        file.fileName = dispositionFilename;
      }

      this.fileStore.ensureDirectory(directory);
      const streamed = await this.streamResponse(response, directory, file.fileName);
      temporaryPath = streamed.temporaryPath;
      this.manifest.transfer.networkFiles += 1;
      this.manifest.transfer.networkBytes += streamed.size;
      const head = streamed.head.toString("utf8").toLowerCase();
      if (
        /text\/html/i.test(contentType) &&
        /<html|<!doctype/.test(head) &&
        !/\.html?$/i.test(file.fileName)
      ) {
        throw new Error(`Expected a file but received HTML (${contentType})`);
      }

      const sizeFields = this.sizeFields(
        file,
        streamed.size,
        label,
        options.allowSizeMismatch
      );
      const identical = this.fileStore.findIdenticalFile(
        directory,
        file.fileName,
        streamed.size,
        streamed.sha256
      );
      if (identical) {
        this.fileStore.removeFile(temporaryPath);
        temporaryPath = null;
        this.manifest.downloads.push({
          label,
          fileName: this.fileStore.baseName(identical),
          path: this.fileStore.relativePath(identical),
          size: streamed.size,
          ...sizeFields,
          contentType,
          sourceUrl: file.sourceUrl,
          finalUrl,
          ...resolutionFields(file),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          sha256: streamed.sha256,
          integrityVerified: true,
          skipped: true,
          contentValidated: true,
        });
        this.emitTransfer("identical", identical, streamed.size, label);
        this.logInfo(
          `validated identical ${this.fileStore.displayPath(identical)} (${streamed.size} bytes)`
        );
        return identical;
      }

      const outputPath = this.fileStore.placeTemporaryFile(
        temporaryPath,
        directory,
        file.fileName
      );
      temporaryPath = null;
      this.manifest.downloads.push({
        label,
        fileName: this.fileStore.baseName(outputPath),
        path: this.fileStore.relativePath(outputPath),
        size: streamed.size,
        ...sizeFields,
        contentType,
        sourceUrl: file.sourceUrl,
        finalUrl,
        ...resolutionFields(file),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        sha256: streamed.sha256,
        integrityVerified: true,
      });
      this.emitTransfer("downloaded", outputPath, streamed.size, label);
      this.logInfo(
        `downloaded ${this.fileStore.displayPath(outputPath)} (${streamed.size} bytes)`
      );
      return outputPath;
    } catch (error) {
      if (temporaryPath) this.fileStore.removeFile(temporaryPath);
      throw error;
    }
  }
}

module.exports = { CourseFileTransferService };
