import { parseBoardPosts } from '../post/parser.js';

function parseRefluxCollectorTitles(html) {
  return parseBoardPosts(html)
    .map((post) => String(post.subject || '').trim())
    .filter(Boolean);
}

export {
  parseRefluxCollectorTitles,
};
