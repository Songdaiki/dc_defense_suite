function parseBoardPosts(html) {
    return collectBoardPosts(html);
}

function parseFluidPosts(html, targetHeadName = '도배기') {
    return collectBoardPosts(html).filter((post) => {
        if (!post.isFluid) {
            return false;
        }

        if (targetHeadName && post.currentHead.includes(targetHeadName)) {
            return false;
        }

        return true;
    });
}

function parseUidBearingPosts(html, targetHeadName = '도배기') {
    return collectBoardPosts(html).filter((post) => {
        if (!post.hasUid) {
            return false;
        }

        if (targetHeadName && post.currentHead.includes(targetHeadName)) {
            return false;
        }

        return true;
    });
}

function extractPostNos(posts) {
    return posts.map((post) => String(post.no));
}

function collectBoardPosts(html) {
    const results = [];
    const rowRegex = /<tr[^>]*class="ub-content[^"]*"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
    let match;

    while ((match = rowRegex.exec(html)) !== null) {
        const postNo = parseInt(match[1], 10);
        if (postNo <= 0) {
            continue;
        }

        const rowHtml = match[2];
        if (!isRegularBoardRow(rowHtml)) {
            continue;
        }

        const writerMeta = extractWriterMeta(rowHtml);
        if (!writerMeta) {
            continue;
        }

        results.push({
            no: postNo,
            uid: writerMeta.uid,
            nick: writerMeta.nick,
            ip: writerMeta.ip,
            isFluid: Boolean(writerMeta.ip),
            hasUid: Boolean(writerMeta.uid),
            subject: extractSubject(rowHtml),
            currentHead: extractCurrentHead(rowHtml),
        });
    }

    return results;
}

function isRegularBoardRow(rowHtml) {
    const gallNumMatch = rowHtml.match(/<td[^>]*class="gall_num[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    if (!gallNumMatch) {
        return false;
    }

    const gallNumText = normalizeText(gallNumMatch[1].replace(/<[^>]+>/g, ' '));
    return /^\d+$/.test(gallNumText);
}

function extractWriterMeta(rowHtml) {
    const writerMatch = rowHtml.match(/<td[^>]*class="gall_writer[^"]*"[^>]*>/);
    if (!writerMatch) {
        return null;
    }

    const writerTag = writerMatch[0];
    const uidMatch = writerTag.match(/data-uid="([^"]*)"/);
    const ipMatch = writerTag.match(/data-ip="([^"]*)"/);
    const nickMatch = writerTag.match(/data-nick="([^"]*)"/);

    return {
        uid: decodeHtml(uidMatch ? uidMatch[1] : ''),
        ip: decodeHtml(ipMatch ? ipMatch[1] : ''),
        nick: decodeHtml(nickMatch ? nickMatch[1] : ''),
    };
}

function extractSubject(rowHtml) {
    const titleMatch = rowHtml.match(/<td[^>]*class="gall_tit[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    if (!titleMatch) {
        return '';
    }

    const titleHtml = titleMatch[1]
        .replace(/<em[^>]*class="icon_[^"]*"[\s\S]*?<\/em>/gi, ' ')
        .replace(/<span[^>]*class="reply_num"[\s\S]*?<\/span>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');

    return normalizeText(titleHtml);
}

function extractCurrentHead(rowHtml) {
    const subjectMatch = rowHtml.match(/<td[^>]*class="gall_subject[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    if (!subjectMatch) {
        return '';
    }

    const subjectHtml = subjectMatch[1]
        .replace(/<p[^>]*class="subject_inner"[\s\S]*?<\/p>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');

    return normalizeText(subjectHtml).replace(/\s*,\s*/g, ',').replace(/,+$/g, '');
}

function extractHeadtextName(html, headtextId) {
    const normalizedHeadtextId = String(headtextId || '').trim();
    if (!normalizedHeadtextId) {
        return '';
    }

    const escapedId = normalizedHeadtextId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`listSearchHead\\(${escapedId}\\)[^>]*>([\\s\\S]*?)<\\/a>`, 'i'),
        new RegExp(`search_head=${escapedId}[^>]*>([\\s\\S]*?)<\\/a>`, 'i'),
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (!match) {
            continue;
        }

        const label = normalizeText(match[1].replace(/<[^>]+>/g, ' '));
        if (label) {
            return label;
        }
    }

    return '';
}

function normalizeText(text) {
    return decodeHtml(String(text || ''))
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeHtml(text) {
    return String(text || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&#39;/g, '\'')
        .replace(/&quot;/gi, '"')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

export {
    extractHeadtextName,
    extractPostNos,
    parseBoardPosts,
    parseFluidPosts,
    parseUidBearingPosts,
};
