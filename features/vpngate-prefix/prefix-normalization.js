const IPV4_PREFIX_REGEX = /^(\d+)\.(\d+)/;

function normalizeVpnGatePrefix(value) {
  const normalized = String(value ?? '')
    .replace(/[()]/g, '')
    .trim();
  if (!normalized) {
    return '';
  }

  const prefixMatch = normalized.match(IPV4_PREFIX_REGEX);
  if (!prefixMatch) {
    return '';
  }

  return `${prefixMatch[1]}.${prefixMatch[2]}`;
}

function sortUniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

function buildNormalizedPrefixSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeVpnGatePrefix(value))
      .filter(Boolean),
  );
}

function filterItemsByPrefix(items, effectivePrefixSet, valueSelector) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const prefix = normalizeVpnGatePrefix(valueSelector(item));
    return prefix && effectivePrefixSet.has(prefix);
  });
}

function filterPostsByVpnGatePrefixes(posts, effectivePrefixSet) {
  return filterItemsByPrefix(posts, effectivePrefixSet, (post) => post?.ip);
}

function filterCommentsByVpnGatePrefixes(comments, effectivePrefixSet) {
  return filterItemsByPrefix(comments, effectivePrefixSet, (comment) => comment?.ip);
}

export {
  buildNormalizedPrefixSet,
  filterCommentsByVpnGatePrefixes,
  filterPostsByVpnGatePrefixes,
  normalizeVpnGatePrefix,
  sortUniqueStrings,
};
