function contentAttachmentCollectionPath(courseId, contentId) {
  return (
    `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}` +
    `/contents/${encodeURIComponent(contentId)}/attachments`
  );
}

function contentAttachmentDownloadPath(courseId, contentId, attachmentId) {
  return (
    `${contentAttachmentCollectionPath(courseId, contentId)}` +
    `/${encodeURIComponent(attachmentId)}/download`
  );
}

function isUnsupportedAttachmentResponse(error) {
  return (
    /400 Bad Request/i.test(String(error?.message || "")) &&
    /content item does not support file attachments/i.test(String(error?.message || ""))
  );
}

function normalizeAttachment(entry, { courseId, contentId }) {
  const id = entry?.id || entry?.fileId || null;
  const fileName = entry?.fileName || entry?.name || entry?.title || null;
  if (!id || !fileName) {
    throw new Error(
      `Blackboard returned incomplete attachment metadata for content ${contentId}`
    );
  }
  return {
    fileId: id,
    fileName,
    mimeType: entry.mimeType || entry.file?.mimeType || "",
    fileSize: entry.fileSize ?? entry.size ?? entry.file?.fileSize ?? null,
    url: contentAttachmentDownloadPath(courseId, contentId, id),
  };
}

class BlackboardContentAttachmentGateway {
  constructor({ client }) {
    if (!client?.all) {
      throw new Error("BlackboardContentAttachmentGateway requires a paginated REST client");
    }
    this.client = client;
  }

  async list({ courseId, contentId }) {
    const endpoint = contentAttachmentCollectionPath(courseId, contentId);
    try {
      const results = await this.client.all(endpoint);
      return {
        attachments: results.map((entry) =>
          normalizeAttachment(entry, { courseId, contentId })
        ),
        endpoint,
        supported: true,
      };
    } catch (error) {
      if (isUnsupportedAttachmentResponse(error)) {
        return { attachments: [], endpoint, supported: false };
      }
      throw error;
    }
  }
}

module.exports = {
  BlackboardContentAttachmentGateway,
  contentAttachmentCollectionPath,
  contentAttachmentDownloadPath,
  isUnsupportedAttachmentResponse,
  normalizeAttachment,
};
