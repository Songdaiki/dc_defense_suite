function normalizeRefluxSearchGalleryId(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidRefluxSearchGalleryId(value) {
  return /^[a-z0-9_]+$/i.test(normalizeRefluxSearchGalleryId(value));
}

function resolveRefluxSearchGalleryId(config = {}) {
  const explicitSearchGalleryId = normalizeRefluxSearchGalleryId(config?.refluxSearchGalleryId);
  if (explicitSearchGalleryId) {
    return explicitSearchGalleryId;
  }

  return normalizeRefluxSearchGalleryId(config?.galleryId);
}

export {
  isValidRefluxSearchGalleryId,
  normalizeRefluxSearchGalleryId,
  resolveRefluxSearchGalleryId,
};
