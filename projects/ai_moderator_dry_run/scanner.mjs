import { fetchPostListHtml } from './fetcher.mjs';
import { parseRegularBoardPosts } from './parser.mjs';

async function scanPagesToQueue({ config, queue, signal = null, force = false }) {
  const pageFrom = Math.max(1, Number(config.pageFrom) || 1);
  const pageTo = Math.max(pageFrom, Number(config.pageTo) || pageFrom);
  const pageResults = [];
  let totalParsed = 0;
  let totalAdded = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (let page = pageFrom; page <= pageTo; page += 1) {
    if (signal?.aborted) {
      throw new Error('스캔이 중단되었습니다.');
    }

    try {
      const html = await fetchPostListHtml(config, page, signal);
      const posts = parseRegularBoardPosts(html).map((post) => ({
        ...post,
        page,
      }));
      const enqueueResult = await queue.enqueuePosts(posts, { force });
      totalParsed += posts.length;
      totalAdded += enqueueResult.added;
      totalUpdated += enqueueResult.updated;
      totalSkipped += enqueueResult.skipped;
      pageResults.push({
        page,
        success: true,
        parsed: posts.length,
        ...enqueueResult,
      });
    } catch (error) {
      pageResults.push({
        page,
        success: false,
        parsed: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        message: error?.message || String(error),
      });
    }
  }

  return {
    success: true,
    pageFrom,
    pageTo,
    totalParsed,
    totalAdded,
    totalUpdated,
    totalSkipped,
    pages: pageResults,
  };
}

export {
  scanPagesToQueue,
};
