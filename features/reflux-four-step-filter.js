const REFLUX_FOUR_STEP_STAGE = Object.freeze({
  DATASET: 'dataset',
  SEARCH_CACHE_POSITIVE: 'search_cache_positive',
  SEARCH_NEGATIVE: 'search_negative',
  SEARCH_PENDING: 'search_pending',
  SEARCH_ERROR: 'search_error',
  SEARCH_MISS: 'search_miss',
});

function inspectRefluxFourStepCandidate({
  value,
  matchesDataset,
  buildSearchContext,
  peekSearchDecision,
} = {}) {
  if (typeof matchesDataset === 'function' && matchesDataset(value)) {
    return buildRefluxFourStepInspectionResult(REFLUX_FOUR_STEP_STAGE.DATASET);
  }

  const searchContext = typeof buildSearchContext === 'function'
    ? buildSearchContext(value)
    : null;
  if (!searchContext) {
    return buildRefluxFourStepInspectionResult(REFLUX_FOUR_STEP_STAGE.SEARCH_NEGATIVE);
  }

  const searchDecision = typeof peekSearchDecision === 'function'
    ? peekSearchDecision(searchContext)
    : null;

  switch (searchDecision?.result) {
    case 'positive':
      return buildRefluxFourStepInspectionResult(
        REFLUX_FOUR_STEP_STAGE.SEARCH_CACHE_POSITIVE,
        searchContext,
        searchDecision,
      );
    case 'negative':
      return buildRefluxFourStepInspectionResult(
        REFLUX_FOUR_STEP_STAGE.SEARCH_NEGATIVE,
        searchContext,
        searchDecision,
      );
    case 'pending':
      return buildRefluxFourStepInspectionResult(
        REFLUX_FOUR_STEP_STAGE.SEARCH_PENDING,
        searchContext,
        searchDecision,
      );
    case 'error':
      return buildRefluxFourStepInspectionResult(
        REFLUX_FOUR_STEP_STAGE.SEARCH_ERROR,
        searchContext,
        searchDecision,
      );
    default:
      return buildRefluxFourStepInspectionResult(
        REFLUX_FOUR_STEP_STAGE.SEARCH_MISS,
        searchContext,
        searchDecision,
      );
  }
}

function buildRefluxFourStepInspectionResult(stage, searchContext = null, searchDecision = null) {
  return {
    stage,
    searchContext,
    searchDecision,
  };
}

export {
  REFLUX_FOUR_STEP_STAGE,
  inspectRefluxFourStepCandidate,
};
