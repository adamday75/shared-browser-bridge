#!/usr/bin/env node
/**
 * M15 Build 1: LinkedIn single-post comment-prep.
 *
 * Read-only inspection of a chosen LinkedIn context via the trusted browser session.
 * Returns a structured follow-up brief useful for deciding what to do next.
 *
 * M15 additions:
 *   - Single-post eligibility detection (isPostDetailPage)
 *   - Commentability judgment — honest assessment of whether a post is worth commenting on
 *   - Grounded comment angles — 1-2 specific angles derived from actual excerpt content
 *   - The system can say "not worth commenting on" — that is a valid, useful outcome
 *
 * Inherited from M14:
 *   - URL-based context classification (feed / post / thread / profile / unknown)
 *   - --mode flag: inspect_only (default) or draft_only
 *   - draft_only mode emits candidate reply/comment drafts without public submission
 *   - Snapshot-based content extraction with de-noising and locality-aware excerpts
 *
 * Demonstrates:
 *   GET /tabs → deterministic LinkedIn target selection → adoptTargetId → url() + text() → follow-up brief
 *
 * Usage:
 *   node scripts/demo-linkedin-followup-brief.mjs --match-url "linkedin.com"
 *   node scripts/demo-linkedin-followup-brief.mjs --match-url "linkedin.com/posts" --mode draft_only
 *
 * Options:
 *   --base-url <url>    Bridge base URL (default: http://127.0.0.1:7820)
 *   --token <token>     Bearer token (if BRIDGE_API_TOKEN is set on the bridge)
 *   --target-id <id>    Select tab by exact CDP target id (from GET /tabs)
 *   --match-url <str>   Select the one tab whose URL contains this string
 *   --match-title <str> Select the one tab whose title contains this string
 *   --mode <mode>       inspect_only (default) or draft_only
 *   --debug             Emit snapshot debug dump (element classification, kept/dropped segments)
 *
 * Exits 0 on PASS, 1 on FAIL.
 * Returns { exitCode, brief } — brief is null on failure.
 *
 * READ-ONLY: this script does not click, post, comment, or mutate any LinkedIn state.
 * draft_only mode emits draft text in the brief JSON — it never types or submits anything.
 */
import { pathToFileURL } from 'node:url';
import { createOpenClawAdapter } from '../src/adapters/openclaw.js';

const EXCERPT_MAX_CHARS = 500;
const VALID_MODES = ['inspect_only', 'draft_only'];

export function parseArgs(argv) {
  const result = {
    baseUrl: 'http://127.0.0.1:7820',
    token: null,
    targetId: null,
    matchUrl: null,
    matchTitle: null,
    mode: 'inspect_only',
    debug: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base-url' && argv[i + 1]) result.baseUrl = argv[++i];
    else if (arg === '--token' && argv[i + 1]) result.token = argv[++i];
    else if (arg === '--target-id' && argv[i + 1]) result.targetId = argv[++i];
    else if (arg === '--match-url' && argv[i + 1]) result.matchUrl = argv[++i];
    else if (arg === '--match-title' && argv[i + 1]) result.matchTitle = argv[++i];
    else if (arg === '--mode' && argv[i + 1]) result.mode = argv[++i];
    else if (arg === '--debug') result.debug = true;
  }
  return result;
}

function createLogger(stdout, stderr) {
  const steps = [];
  return {
    ok(label, detail) {
      stdout.write(`  [OK] ${label}${detail ? ': ' + detail : ''}\n`);
      steps.push({ ok: true, label });
    },
    fail(label, detail) {
      stderr.write(`  [FAIL] ${label}${detail ? ': ' + detail : ''}\n`);
      steps.push({ ok: false, label });
    },
    steps,
  };
}

function buildExcerpt(text) {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= EXCERPT_MAX_CHARS) return collapsed;
  return collapsed.slice(0, EXCERPT_MAX_CHARS) + '…';
}

function isLinkedInUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'www.linkedin.com' || hostname === 'linkedin.com';
  } catch {
    return false;
  }
}

/**
 * Classify the LinkedIn URL into a narrower context type.
 * Returns: 'post' | 'thread' | 'feed' | 'profile' | 'unknown'
 *
 * Post URLs: /posts/*, /pulse/*, /feed/update/urn:li:activity:*
 * Thread hint: post URL where page text suggests active comment thread
 * Feed: /feed/ without a specific activity
 * Profile: /in/*
 */
function classifyLinkedInContext(url, pageText) {
  if (!url) return 'unknown';
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 'unknown';
  }
  if (!isLinkedInUrl(url)) return 'unknown';

  const isPostUrl =
    /^\/posts\//.test(pathname) ||
    /^\/pulse\//.test(pathname) ||
    /^\/feed\/update\//.test(pathname);

  if (isPostUrl) {
    // Distinguish post from thread: if page text suggests visible comment thread, call it 'thread'
    if (pageText) {
      const signals = extractVisibleSignals(pageText);
      if (signals.commentsPresent && signals.replyAffordancesVisible) {
        return 'thread';
      }
    }
    return 'post';
  }

  if (/^\/in\//.test(pathname)) return 'profile';
  if (/^\/feed\/?$/.test(pathname)) return 'feed';

  return 'unknown';
}

/**
 * Generate bounded draft candidates for draft_only mode.
 * Returns an array of { kind, text } objects.
 *
 * This never types, clicks, or submits anything.
 * Drafts are heuristic suggestions based on context and signals.
 */
function generateDrafts({ contextType, excerpt, signals, title, commentAngles = [] }) {
  const drafts = [];

  if ((contextType === 'post' || contextType === 'thread') && commentAngles.length > 0) {
    const primary = cleanGroundingText(commentAngles[0]?.grounding ?? excerpt);
    const secondary = cleanGroundingText(commentAngles[1]?.grounding ?? '');
    const primaryText = primary || excerpt;
    const secondaryText = secondary || '';

    if (contextType === 'thread' && signals.commentsPresent) {
      drafts.push({
        kind: 'reply_candidate',
        text: buildHumanCommentDraft({ primary: primaryText, secondary: secondaryText, mode: 'reply' })
      });
    }

    drafts.push({
      kind: 'comment_candidate',
      text: buildHumanCommentDraft({ primary: primaryText, secondary: secondaryText, mode: 'comment' })
    });
  }

  if (drafts.length === 0 && contextType === 'feed') {
    drafts.push({
      kind: 'engagement_candidate',
      text: 'Worth scanning the feed for a post with enough substance to say something specific, not just add another generic comment.',
    });
  }

  if (drafts.length === 0) {
    drafts.push({
      kind: 'generic_candidate',
      text: `No grounded follow-up draft yet for "${title || 'this page'}" in ${contextType} context.`,
    });
  }

  return drafts;
}

function extractVisibleSignals(pageText) {
  if (!pageText) {
    return {
      commentsPresent: false,
      commentBoxesVisible: false,
      replyAffordancesVisible: false,
      interactionOpportunities: 0,
    };
  }
  const lower = pageText.toLowerCase();

  const commentPatterns = [/\bcomment/i, /\breply/i, /\breplies\b/i];
  const commentsPresent = commentPatterns.some((p) => p.test(pageText));

  const commentBoxPatterns = [/add a comment/i, /write a comment/i, /leave a comment/i];
  const commentBoxesVisible = commentBoxPatterns.some((p) => p.test(pageText));

  const replyPatterns = [/\breply\b/i, /\breplies\b/i];
  const replyAffordancesVisible = replyPatterns.some((p) => p.test(pageText));

  let interactionOpportunities = 0;
  if (commentsPresent) interactionOpportunities++;
  if (commentBoxesVisible) interactionOpportunities++;
  if (replyAffordancesVisible) interactionOpportunities++;

  return {
    commentsPresent,
    commentBoxesVisible,
    replyAffordancesVisible,
    interactionOpportunities,
  };
}

/**
 * LinkedIn chrome/nav noise patterns — short action words and nav strings
 * that appear as link or button text but carry no post content.
 * Case-insensitive match against trimmed element text.
 */
const LINKEDIN_NOISE_EXACT = new Set([
  'like', 'comment', 'repost', 'send', 'share', 'save',
  'follow', 'connect', 'message', 'report', 'copy link',
  'more', 'see more', 'show more', 'load more', '…',
  'home', 'my network', 'jobs', 'messaging', 'notifications',
  'post', 'me', 'work', 'premium', 'try premium',
  'sign in', 'sign up', 'join now', 'learn more',
  'edit', 'delete', 'hide', 'mute', 'block',
  'reactions', 'likes', 'celebrates', 'supports', 'loves',
  'open to work', 'promoted', 'suggested',
  // Sidebar / "People" / profile chrome
  'people', 'people also viewed', 'people you may know',
  'add to your feed', 'linkedin news', 'today\'s top stories',
  'show all', 'view all', 'view profile', 'view full profile',
  'about', 'experience', 'education', 'skills', 'activity',
  'interests', 'groups', 'events', 'hashtags',
  'mutual connections', 'mutual connection',
  'see all activity', 'see all recommendations',
  // Footer / legal
  'linkedin corporation', 'user agreement', 'privacy policy',
  'cookie policy', 'copyright policy', 'brand policy',
  'accessibility', 'talent solutions', 'community guidelines',
  // Messaging / overlay
  'new message', 'start a post', 'write article',
  'add a photo', 'add a video', 'create an event',
  // Post-detail page chrome (M15 Build 2)
  'feed detail update', 'feed post', 'feed detail',
  'graphic link', 'emoji link', 'image link',
]);

/**
 * Patterns that indicate LinkedIn chrome even in longer text.
 */
const LINKEDIN_NOISE_PATTERNS = [
  /^\d+\s*(comments?|likes?|reactions?|reposts?|followers?|connections?)$/i,
  /^\d+[,.\d]*\s*(comments?|likes?|reactions?|reposts?|followers?|connections?)$/i,
  /^(liked by|commented on|reposted by|shared by)\b/i,
  /^you and \d+ other/i,
  /^(skip to|jump to|go to)\b/i,
  /^\d+\s*new\s*(notification|message)/i,
  // Profile / sidebar / card patterns
  /^\d+\s*(mutual\s+connections?|endorsements?)$/i,
  /^(connect with|follow)\s+\w/i,
  /^(view|see)\s+(all|more|\d+)\b/i,
  /^(posted|shared|commented)\s+\d+\s*(d|h|w|m|mo|yr|day|hour|week|month|year)s?\s*(ago)?$/i,
  /^[\w\s]+(university|college|school|institute)\s*$/i,
  /^(sr|jr|senior|junior|lead|head|chief|vp|director|manager|engineer|developer|analyst|consultant|associate|intern)\b.{0,50}$/i,
  /^\d+(st|nd|rd|th)\+?\s*$/i,
  /^[•·|–—-]\s*$/,
  // Post-detail page chrome labels (M15 Build 2)
  /^feed\s+(detail\s+)?update$/i,
  /^feed\s+post$/i,
  /^\d+\s*notifications?\s*total$/i,
  /^uncover\s+the\s+right\s+buyers?\b/i,
  /^(sales\s*navigator|sales\s*nav|try\s+sales\s+navigator)\b/i,
  // Reaction facepile / graphic-link junk
  /^[\w\s,]+and\s+\d+\s+others?$/i,
  /^(emoji|graphic|image|photo|video)\s*(link)?$/i,
  // M15 Build 3: author/byline shell and reaction suppression
  /^view\s+.+('s\s+)?graphic\s+link$/i,
  /\breacted\s+with\s+(empathy|like|celebrate|support|love|insightful|funny)\b/i,
  /^open\s+control\s+menu\s+for\s+post\s+by\b/i,
  /^hide\s+post\s+by\b/i,
  /^following$/i,
  /^1st(\+)?$|^2nd(\+)?$|^3rd(\+)?$/i,
  /^view\s+[\w\s.''-]+profile$/i,
];

/**
 * Returns true if the text looks like LinkedIn chrome/nav noise.
 */
function isLinkedInNoise(text) {
  const lower = text.toLowerCase().trim();
  if (LINKEDIN_NOISE_EXACT.has(lower)) return true;
  return LINKEDIN_NOISE_PATTERNS.some((p) => p.test(text));
}

/**
 * Build a debug dump of the local cluster around the matched anchor element.
 * This answers: "Is the real post body present near the anchor in the snapshot?"
 *
 * Returns a plain object with:
 *   - anchorIndex: which element was chosen as anchor (-1 if none)
 *   - anchorCues: { authorSlug, activityId } extracted from the URL
 *   - windowSize: how many elements on each side we inspected
 *   - cluster: array of { index, distance, tag, id, textExcerpt, charLen, disposition, score }
 *     disposition is 'kept' | 'dropped:reason'
 *
 * Designed for the Basia-class debugging question:
 *   "Is the post body in the snapshot near the anchor, or absent entirely?"
 */
function buildAnchorClusterDebug(snapshotElements, readUrl, windowSize) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) {
    return { anchorIndex: -1, anchorCues: { authorSlug: null, activityId: null }, windowSize, cluster: [], elementCount: 0 };
  }

  const anchorCues = extractPostAnchorFromUrl(readUrl);
  const anchorIndex = findAnchorIndex(snapshotElements, readUrl);
  const w = windowSize ?? LOCALITY_WINDOW;

  const lo = Math.max(0, anchorIndex < 0 ? 0 : anchorIndex - w);
  const hi = Math.min(snapshotElements.length - 1, anchorIndex < 0 ? Math.min(snapshotElements.length - 1, 2 * w) : anchorIndex + w);

  const noiseTags = new Set(['button', 'input', 'textarea', 'select', 'nav', 'footer', 'header']);
  const seen = new Set();
  const cluster = [];

  for (let i = lo; i <= hi; i++) {
    const el = snapshotElements[i];
    const text = (el.text ?? '').trim();
    const distance = anchorIndex >= 0 ? i - anchorIndex : null;

    // Determine disposition (same logic as extractSnapshotText / buildLocalityAwareExcerpt)
    let disposition = 'kept';
    if (!text || text.length < 3) {
      disposition = 'dropped:too_short';
    } else if (seen.has(text)) {
      disposition = 'dropped:duplicate';
    } else {
      seen.add(text);
      if (noiseTags.has(el.tag) && text.length < 40) {
        disposition = 'dropped:noise_tag';
      } else if (isLinkedInNoise(text)) {
        disposition = 'dropped:linkedin_noise';
      } else if (el.tag === 'a' && text.length < ANCHOR_MIN_CONTENT_LENGTH) {
        disposition = 'dropped:short_anchor';
      }
    }

    const score = disposition === 'kept' ? scoreContentElement(el.tag, text) : 0;
    const localityBonus = (disposition === 'kept' && anchorIndex >= 0 && Math.abs(distance) <= w)
      ? Math.round(LOCALITY_BONUS * (1 - Math.abs(distance) / w))
      : 0;

    cluster.push({
      index: i,
      distance,
      tag: el.tag ?? '(none)',
      id: el.id ?? null,
      textExcerpt: text.slice(0, 120) + (text.length > 120 ? '…' : ''),
      charLen: text.length,
      disposition,
      score,
      localityBonus,
      totalScore: score + localityBonus,
    });
  }

  // Surface inferred author cues for debug visibility (Build 8 compat)
  const inferred = inferAuthorFromSnapshot(snapshotElements);
  const inferredAuthor = inferred ? { authorName: inferred.authorName, sourceIndex: inferred.sourceIndex } : null;

  // Build 9: surface candidate-anchor disambiguation results
  const disambiguation = disambiguateCandidateAnchors(snapshotElements);
  const disambiguationDebug = disambiguation ? {
    reason: disambiguation.reason,
    winnerAuthor: disambiguation.winner.authorName,
    winnerSourceIndex: disambiguation.winner.sourceIndex,
    winnerAnchorIndex: disambiguation.winner.anchorIndex,
    winnerClusterScore: disambiguation.winner.clusterScore,
    winnerKeptCount: disambiguation.winner.keptCount,
    winnerKeptChars: disambiguation.winner.keptChars,
    candidateCount: disambiguation.candidates.length,
    candidates: disambiguation.candidates.map((c) => ({
      authorName: c.authorName,
      sourceIndex: c.sourceIndex,
      anchorIndex: c.anchorIndex,
      clusterScore: c.clusterScore,
      keptCount: c.keptCount,
      keptChars: c.keptChars,
    })),
  } : null;

  return {
    anchorIndex,
    anchorCues,
    inferredAuthor,
    disambiguation: disambiguationDebug,
    windowSize: w,
    clusterRange: `[${lo}..${hi}] of ${snapshotElements.length} elements`,
    cluster,
    elementCount: snapshotElements.length,
  };
}

/**
 * Build 10: Comparative candidate cluster debug.
 *
 * For EACH author-anchor candidate in the snapshot, dumps the full local
 * neighborhood cluster with per-element disposition, score, and text.
 * This answers the Build 9 live failure question:
 *   "Is Basia's real post body absent from the snapshot near her anchor,
 *    or present but being filtered/scored away?"
 *
 * Returns { candidateCount, candidates: [ { authorName, sourceIndex, anchorIndex,
 *   clusterScore, keptCount, keptChars, cluster: [ per-element details ] } ] }
 *
 * Each candidate's cluster array mirrors the buildAnchorClusterDebug format:
 *   { index, distance, tag, id, textExcerpt, charLen, disposition, score, localityBonus, totalScore }
 */
function buildComparativeCandidateDebug(snapshotElements, windowSize) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) {
    return { candidateCount: 0, candidates: [] };
  }

  const raw = collectAllAuthorCandidates(snapshotElements);
  if (raw.length === 0) {
    return { candidateCount: 0, candidates: [] };
  }

  const w = windowSize ?? CANDIDATE_CLUSTER_WINDOW;
  const noiseTags = new Set(['button', 'input', 'textarea', 'select', 'nav', 'footer', 'header']);

  const candidates = raw.map((c) => {
    const { anchorIndex, clusterScore, keptCount, keptChars } = scoreCandidateCluster(snapshotElements, c, w);

    // Build per-element cluster dump around this candidate's sourceIndex
    const lo = Math.max(0, c.sourceIndex - w);
    const hi = Math.min(snapshotElements.length - 1, c.sourceIndex + w);

    const seen = new Set();
    const cluster = [];

    for (let i = lo; i <= hi; i++) {
      const el = snapshotElements[i];
      const text = (el.text ?? '').trim();
      const distance = i - c.sourceIndex;

      let disposition = 'kept';
      if (!text || text.length < 3) {
        disposition = 'dropped:too_short';
      } else if (seen.has(text)) {
        disposition = 'dropped:duplicate';
      } else {
        seen.add(text);
        if (noiseTags.has(el.tag) && text.length < 40) {
          disposition = 'dropped:noise_tag';
        } else if (isLinkedInNoise(text)) {
          disposition = 'dropped:linkedin_noise';
        } else if (el.tag === 'a' && text.length < ANCHOR_MIN_CONTENT_LENGTH) {
          disposition = 'dropped:short_anchor';
        }
      }

      const score = disposition === 'kept' ? scoreContentElement(el.tag, text) : 0;
      const localityBonus = (disposition === 'kept' && Math.abs(distance) <= w)
        ? Math.round(LOCALITY_BONUS * (1 - Math.abs(distance) / w))
        : 0;

      cluster.push({
        index: i,
        distance,
        tag: el.tag ?? '(none)',
        id: el.id ?? null,
        textExcerpt: text.slice(0, 120) + (text.length > 120 ? '…' : ''),
        charLen: text.length,
        disposition,
        score,
        localityBonus,
        totalScore: score + localityBonus,
      });
    }

    return {
      authorName: c.authorName,
      sourceIndex: c.sourceIndex,
      anchorIndex,
      clusterScore,
      keptCount,
      keptChars,
      clusterRange: `[${lo}..${hi}]`,
      cluster,
    };
  });

  // Sort by clusterScore descending to make the ranking obvious
  candidates.sort((a, b) => b.clusterScore - a.clusterScore || b.keptChars - a.keptChars);

  return {
    candidateCount: candidates.length,
    candidates,
  };
}

/**
 * Build a debug dump of snapshot elements for inspection.
 * Groups elements by tag, shows what was kept vs filtered, and surfaces
 * the exact text segments feeding into signal extraction.
 * Returns a plain object suitable for JSON serialization.
 */
function buildSnapshotDebugDump(snapshotElements, filteredText, rawText, pageText) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) {
    return {
      elementCount: 0,
      tagDistribution: {},
      filteredSegments: [],
      droppedSegments: [],
      rawTextLength: 0,
      filteredTextLength: 0,
      pageTextLength: pageText?.length ?? 0,
      signalSourceUsed: 'pageText',
    };
  }

  // Tag distribution
  const tagCounts = {};
  for (const el of snapshotElements) {
    const tag = el.tag ?? '(none)';
    tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  }

  // Classify each element as kept or dropped by the filter
  const noiseTags = new Set(['button', 'input', 'textarea', 'select', 'nav', 'footer', 'header']);
  const seen = new Set();
  const filteredSegments = [];
  const droppedSegments = [];

  for (const el of snapshotElements) {
    const text = (el.text ?? '').trim();
    if (!text || text.length < 3) {
      if (text) droppedSegments.push({ tag: el.tag, text, reason: 'too_short' });
      continue;
    }
    if (seen.has(text)) {
      droppedSegments.push({ tag: el.tag, text: text.slice(0, 80), reason: 'duplicate' });
      continue;
    }
    seen.add(text);

    // Replay the filter logic to classify
    if (noiseTags.has(el.tag) && text.length < 40) {
      droppedSegments.push({ tag: el.tag, text, reason: 'noise_tag' });
      continue;
    }
    if (isLinkedInNoise(text)) {
      droppedSegments.push({ tag: el.tag, text, reason: 'linkedin_noise' });
      continue;
    }
    if (el.tag === 'a' && text.length < ANCHOR_MIN_CONTENT_LENGTH) {
      droppedSegments.push({ tag: el.tag, text, reason: 'short_anchor' });
      continue;
    }
    filteredSegments.push({ tag: el.tag, text: text.slice(0, 200), charLen: text.length });
  }

  const signalSourceUsed = (pageText.length < 50 && rawText.length > pageText.length) ? 'rawSnapshotText' : 'pageText';

  return {
    elementCount: snapshotElements.length,
    tagDistribution: tagCounts,
    filteredSegments,
    filteredSegmentCount: filteredSegments.length,
    droppedSegments,
    droppedSegmentCount: droppedSegments.length,
    rawTextLength: rawText.length,
    filteredTextLength: filteredText.length,
    pageTextLength: pageText?.length ?? 0,
    signalSourceUsed,
  };
}

/**
 * Extract raw text from snapshot elements with only dedup and basic cleanup.
 * Used for signal extraction so that chrome words like "comment", "reply"
 * are still visible to the signal detector even though they are noise for excerpts.
 */
function extractRawSnapshotText(snapshotElements) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) return '';
  const seen = new Set();
  const parts = [];
  for (const el of snapshotElements) {
    const text = (el.text ?? '').trim();
    if (!text || text.length < 3) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.join(' ');
}

/**
 * Extract meaningful text from snapshot elements, filtering out nav/button noise
 * and LinkedIn chrome patterns.
 * Snapshot elements are { tag, text, id } objects from GET /page/snapshot.
 */
/**
 * Minimum character length for anchor/link text to be considered content.
 * Most LinkedIn nav/chrome links are short labels (profile names, action words).
 * Genuine post content in <a> tags tends to be longer.
 */
const ANCHOR_MIN_CONTENT_LENGTH = 30;

function extractSnapshotText(snapshotElements) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) return '';

  // Tags that carry content headings
  const headingTags = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'span', 'div', 'article', 'section']);
  // Tags that are almost always UI chrome
  const noiseTags = new Set(['button', 'input', 'textarea', 'select', 'nav', 'footer', 'header']);

  const seen = new Set();
  const parts = [];

  for (const el of snapshotElements) {
    const text = (el.text ?? '').trim();
    if (!text || text.length < 3) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    // Skip noise tags — raise threshold to 40 chars (longer button labels are still chrome)
    if (noiseTags.has(el.tag) && text.length < 40) continue;

    // Skip LinkedIn-specific chrome/nav noise regardless of tag
    if (isLinkedInNoise(text)) continue;

    // Anchor tags: only keep if text is long enough to likely be content, not a nav label
    if (el.tag === 'a' && text.length < ANCHOR_MIN_CONTENT_LENGTH) continue;

    parts.push(text);
  }

  return parts.join(' ');
}

/**
 * Compute content quality based on the best available text length.
 * Returns 'rich' | 'partial' | 'sparse'.
 */
function computeContentQuality(bestTextLength) {
  if (bestTextLength >= 200) return 'rich';
  if (bestTextLength >= 50) return 'partial';
  return 'sparse';
}

/**
 * Score a filtered snapshot element by likelihood of being actual post/thread content.
 * Higher score = more likely to be the post body or a substantive comment.
 */
function scoreContentElement(tag, text) {
  let score = 0;
  const len = text.length;

  // Headings are very likely post titles or section headers
  if (tag === 'h1') score += 30;
  else if (tag === 'h2') score += 25;
  else if (tag === 'h3') score += 20;

  // Semantic content containers
  if (tag === 'article' || tag === 'section') score += 10;
  if (tag === 'p') score += 8;

  // Length is a strong signal — longer text is more likely substantive content
  if (len >= 100) score += 20;
  else if (len >= 60) score += 12;
  else if (len >= 40) score += 5;

  return score;
}

/**
 * Extract locality anchor cues from a LinkedIn post/thread URL.
 * Returns { authorSlug, activityId } — either or both may be null.
 *
 * These cues help identify which snapshot elements belong to the target post
 * so the excerpt can prefer nearby content over unrelated feed items.
 */
function extractPostAnchorFromUrl(url) {
  if (!url) return { authorSlug: null, activityId: null };
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return { authorSlug: null, activityId: null }; }

  // /posts/author-slug-HASH or /posts/author-slug/...
  const postsMatch = pathname.match(/^\/posts\/([a-z0-9][\w-]*)/i);
  const authorSlug = postsMatch ? postsMatch[1].toLowerCase() : null;

  // /feed/update/urn:li:activity:DIGITS
  const activityMatch = pathname.match(/urn:li:activity:(\d+)/);
  const activityId = activityMatch ? activityMatch[1] : null;

  return { authorSlug, activityId };
}

/**
 * Infer the target-post author name from snapshot element text patterns.
 * Looks for LinkedIn control-menu / hide-post patterns that embed the author name:
 *   - "Open control menu for post by <Name>"
 *   - "Hide post by <Name>"
 *
 * Returns { authorName, sourceIndex } on success, or null if no pattern matched.
 * Only the first match is returned — on a single-post page the target post's
 * control-menu pattern typically appears before any other post's pattern.
 */
const AUTHOR_INFERENCE_PATTERNS = [
  /(?:open\s+control\s+menu\s+for\s+post\s+by|hide\s+post\s+by)\s+(.+)/i,
];

function inferAuthorFromSnapshot(snapshotElements) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) return null;

  for (let i = 0; i < snapshotElements.length; i++) {
    const text = (snapshotElements[i].text ?? '').trim();
    if (!text) continue;
    for (const pattern of AUTHOR_INFERENCE_PATTERNS) {
      const m = text.match(pattern);
      if (m && m[1]) {
        const authorName = m[1].trim();
        if (authorName.length >= 3) {
          return { authorName, sourceIndex: i };
        }
      }
    }
  }
  return null;
}

/**
 * Collect ALL author-anchor candidates from the snapshot, not just the first.
 * Each candidate represents a distinct "post by <Name>" pattern occurrence.
 * Returns an array of { authorName, sourceIndex }.
 */
function collectAllAuthorCandidates(snapshotElements) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) return [];

  const candidates = [];
  for (let i = 0; i < snapshotElements.length; i++) {
    const text = (snapshotElements[i].text ?? '').trim();
    if (!text) continue;
    for (const pattern of AUTHOR_INFERENCE_PATTERNS) {
      const m = text.match(pattern);
      if (m && m[1]) {
        const authorName = m[1].trim();
        if (authorName.length >= 3) {
          candidates.push({ authorName, sourceIndex: i });
        }
      }
    }
  }
  return candidates;
}

/**
 * Score a candidate anchor's local cluster by content density.
 * Looks at elements within ±window of the candidate's sourceIndex and sums
 * the character length of kept (non-noise, non-duplicate) elements.
 *
 * A richer cluster means the candidate is more likely to be the target post
 * rather than a thin sidebar card or chrome fragment.
 *
 * Returns { anchorIndex, clusterScore, keptCount, keptChars }.
 */
const CANDIDATE_CLUSTER_WINDOW = 10;

function scoreCandidateCluster(snapshotElements, candidate, window) {
  const w = window ?? CANDIDATE_CLUSTER_WINDOW;
  const lo = Math.max(0, candidate.sourceIndex - w);
  const hi = Math.min(snapshotElements.length - 1, candidate.sourceIndex + w);

  const noiseTags = new Set(['button', 'input', 'textarea', 'select', 'nav', 'footer', 'header']);
  const seen = new Set();
  let keptCount = 0;
  let keptChars = 0;
  let clusterScore = 0;

  for (let i = lo; i <= hi; i++) {
    const el = snapshotElements[i];
    const text = (el.text ?? '').trim();
    if (!text || text.length < 3) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    if (noiseTags.has(el.tag) && text.length < 40) continue;
    if (isLinkedInNoise(text)) continue;
    if (el.tag === 'a' && text.length < ANCHOR_MIN_CONTENT_LENGTH) continue;

    keptCount++;
    keptChars += text.length;
    const baseScore = scoreContentElement(el.tag, text);
    // Locality weighting: elements closer to the candidate's sourceIndex
    // contribute more, so a candidate surrounded by rich content wins over
    // one that merely shares a wide window with distant content.
    const distance = Math.abs(i - candidate.sourceIndex);
    const localityWeight = 1 - distance / (w + 1);
    clusterScore += baseScore + Math.round(LOCALITY_BONUS * localityWeight);
  }

  // Find the best anchor index for this candidate: prefer an earlier byline mention
  // over the control-menu element itself.
  const inferredLower = candidate.authorName.toLowerCase();
  let anchorIndex = candidate.sourceIndex;
  for (let i = lo; i <= hi; i++) {
    if (i === candidate.sourceIndex) continue;
    const text = (snapshotElements[i].text ?? '').toLowerCase();
    if (text.includes(inferredLower)) {
      anchorIndex = i;
      break;
    }
  }

  return { anchorIndex, clusterScore, keptCount, keptChars };
}

/**
 * Build 9: Candidate-anchor disambiguation.
 *
 * When multiple "post by <Name>" patterns appear in the snapshot (common on
 * /feed/update/ pages that also show neighboring feed cards), this function
 * scores each candidate's local cluster and picks the one with the highest
 * content density.
 *
 * The rationale: on a single-post permalink page, the target post typically
 * has the richest content cluster (full body text, multiple paragraphs,
 * numbered lists, etc.), while neighboring feed cards are thin (just a
 * headline or a short excerpt).
 *
 * Returns { winner, candidates, reason } where:
 *   - winner: the chosen candidate with { authorName, sourceIndex, anchorIndex, clusterScore, ... }
 *   - candidates: all scored candidates for debug visibility
 *   - reason: human-readable string explaining the choice
 *
 * Returns null if no candidates found.
 */
function disambiguateCandidateAnchors(snapshotElements, window) {
  const raw = collectAllAuthorCandidates(snapshotElements);
  if (raw.length === 0) return null;

  const scored = raw.map((c) => {
    const cluster = scoreCandidateCluster(snapshotElements, c, window);
    return { ...c, ...cluster };
  });

  if (scored.length === 1) {
    return {
      winner: scored[0],
      candidates: scored,
      reason: 'single candidate — no disambiguation needed',
    };
  }

  // Sort by clusterScore descending, then by keptChars descending as tiebreak
  scored.sort((a, b) => b.clusterScore - a.clusterScore || b.keptChars - a.keptChars);

  const best = scored[0];
  const second = scored[1];

  // Only declare a clear winner if the best candidate meaningfully outscores the runner-up
  if (best.clusterScore > second.clusterScore) {
    return {
      winner: best,
      candidates: scored,
      reason: `candidate "${best.authorName}" (index ${best.sourceIndex}) won with clusterScore=${best.clusterScore} vs runner-up "${second.authorName}" (score=${second.clusterScore})`,
    };
  }

  // Tied on clusterScore — use keptChars as tiebreak
  if (best.keptChars > second.keptChars) {
    return {
      winner: best,
      candidates: scored,
      reason: `candidate "${best.authorName}" (index ${best.sourceIndex}) won tiebreak on keptChars=${best.keptChars} vs "${second.authorName}" (keptChars=${second.keptChars})`,
    };
  }

  // Truly inconclusive — fall back to first candidate (preserve Build 8 behavior)
  const first = scored.find((c) => c.sourceIndex === raw[0].sourceIndex) ?? scored[0];
  return {
    winner: first,
    candidates: scored,
    reason: `disambiguation inconclusive (tied scores) — falling back to first candidate "${first.authorName}"`,
  };
}

/**
 * Find the DOM index of the element most likely to anchor the target post.
 * Searches element text and id fields for URL-derived cues (activity ID, author name).
 *
 * Build 8: When URL-derived cues fail (activityId not in elements, no authorSlug),
 * falls back to author-anchor inference — scanning snapshot text for patterns like
 * "Open control menu for post by <Name>" to infer the author, then searching for
 * that author's name in element text to find the anchor.
 *
 * Returns -1 if no anchor found.
 */
const LOCALITY_WINDOW = 15;
const LOCALITY_BONUS = 25;

function findAnchorIndex(snapshotElements, readUrl) {
  const { authorSlug, activityId } = extractPostAnchorFromUrl(readUrl);

  // Phase 1: URL-derived cues
  if (authorSlug || activityId) {
    for (let i = 0; i < snapshotElements.length; i++) {
      const el = snapshotElements[i];
      const text = (el.text ?? '').toLowerCase();
      const id = (el.id ?? '').toLowerCase();

      // Activity ID is a strong unique signal
      if (activityId && (text.includes(activityId) || id.includes(activityId))) return i;

      // Author slug: match as space-separated name (hyphens → spaces)
      if (authorSlug && authorSlug.length > 3) {
        const authorName = authorSlug.replace(/-/g, ' ');
        if (text.includes(authorName) || id.includes(authorSlug)) return i;

        // LinkedIn slugs have a trailing hash/ID suffix (e.g. jane-doe-abc123).
        // Try without the last segment to match just the name.
        const parts = authorSlug.split('-');
        if (parts.length >= 3) {
          const nameWithoutHash = parts.slice(0, -1).join(' ');
          if (nameWithoutHash.length > 3 && (text.includes(nameWithoutHash) || id.includes(parts.slice(0, -1).join('-')))) return i;
        }
      }
    }
  }

  // Phase 2: candidate-anchor disambiguation from snapshot text patterns.
  // Build 9: collects ALL "post by <Name>" candidates, scores each cluster,
  // and picks the one with the richest local content — not just the first match.
  // Only attempted for post-type URLs where URL cues were insufficient.
  if (!readUrl) return -1;
  let isPostUrl = false;
  try {
    const pathname = new URL(readUrl).pathname;
    isPostUrl = /^\/posts\//.test(pathname) ||
                /^\/pulse\//.test(pathname) ||
                /^\/feed\/update\//.test(pathname);
  } catch { /* not a valid URL */ }
  if (!isPostUrl) return -1;

  const disambiguation = disambiguateCandidateAnchors(snapshotElements);
  if (!disambiguation) return -1;

  return disambiguation.winner.anchorIndex;
}

/**
 * Build a locality-aware excerpt from snapshot elements for post/thread URLs.
 * When an anchor element is found (matching URL-derived cues), elements near it
 * in DOM order receive a score bonus so the excerpt favors the target post cluster
 * over unrelated feed items elsewhere in the page.
 *
 * Falls back to global content-focused ranking when:
 *   - URL is not a post/thread type
 *   - no anchor element found
 */
function buildLocalityAwareExcerpt(snapshotElements, readUrl) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) return '';

  // Only apply locality for post-type URLs
  let isPost = false;
  if (readUrl) {
    try {
      const pathname = new URL(readUrl).pathname;
      isPost = /^\/posts\//.test(pathname) ||
               /^\/pulse\//.test(pathname) ||
               /^\/feed\/update\//.test(pathname);
    } catch { /* not a valid URL, skip locality */ }
  }

  if (!isPost) return buildContentFocusedExcerpt(snapshotElements);

  const anchorIdx = findAnchorIndex(snapshotElements, readUrl);
  if (anchorIdx < 0) return buildContentFocusedExcerpt(snapshotElements);

  // Filter and score with locality bonus
  const noiseTags = new Set(['button', 'input', 'textarea', 'select', 'nav', 'footer', 'header']);
  const seen = new Set();
  const scored = [];

  for (let i = 0; i < snapshotElements.length; i++) {
    const el = snapshotElements[i];
    const text = (el.text ?? '').trim();
    if (!text || text.length < 3) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    if (noiseTags.has(el.tag) && text.length < 40) continue;
    if (isLinkedInNoise(text)) continue;
    if (el.tag === 'a' && text.length < ANCHOR_MIN_CONTENT_LENGTH) continue;

    let score = scoreContentElement(el.tag, text);

    // Locality bonus: linear decay from full bonus at anchor to zero at window edge
    const distance = Math.abs(i - anchorIdx);
    if (distance <= LOCALITY_WINDOW) {
      score += Math.round(LOCALITY_BONUS * (1 - distance / LOCALITY_WINDOW));
    }

    scored.push({ tag: el.tag, text, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const joined = scored.map((s) => s.text).join(' ');
  return buildExcerpt(joined);
}

/**
 * Build a content-focused excerpt from snapshot elements.
 * Applies the same filtering as extractSnapshotText, but then ranks kept elements
 * by content-likelihood score so the excerpt foregrounds actual post/thread text
 * rather than whatever happens to come first in DOM order.
 *
 * Returns the ranked excerpt string (truncated to EXCERPT_MAX_CHARS).
 */
function buildContentFocusedExcerpt(snapshotElements) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) return '';

  const noiseTags = new Set(['button', 'input', 'textarea', 'select', 'nav', 'footer', 'header']);
  const seen = new Set();
  const scored = [];

  for (const el of snapshotElements) {
    const text = (el.text ?? '').trim();
    if (!text || text.length < 3) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    // Same filtering as extractSnapshotText
    if (noiseTags.has(el.tag) && text.length < 40) continue;
    if (isLinkedInNoise(text)) continue;
    if (el.tag === 'a' && text.length < ANCHOR_MIN_CONTENT_LENGTH) continue;

    scored.push({ tag: el.tag, text, score: scoreContentElement(el.tag, text) });
  }

  // Sort by score descending, stable (preserve DOM order for equal scores)
  scored.sort((a, b) => b.score - a.score);

  const joined = scored.map((s) => s.text).join(' ');
  return buildExcerpt(joined);
}

// ─── M15 Build 2: Post-body isolation for cleaner grounding ───

/**
 * Minimum character length for a segment to count as "prose-like" body content.
 * Short fragments (names, labels, counts) are almost never post body text.
 */
const BODY_MIN_PROSE_LENGTH = 30;

/**
 * Patterns that indicate pre-anchor page chrome on post-detail pages.
 * These appear before the author byline and pollute grounding if included.
 */
const PRE_ANCHOR_CHROME_PATTERNS = [
  /^feed\b/i,
  /notification/i,
  /^adam\s/i,       // self-profile text leaking from nav
  /^\d+\s*notification/i,
  /^messaging/i,
  /^my\s+network/i,
  /^home$/i,
  /^jobs$/i,
  /^sales\s*nav/i,
];

/**
 * M15 Build 3: Patterns that identify author/byline shell text in the
 * post-anchor region. These are NOT the post body — they're the identity
 * metadata that appears between the author anchor and the actual prose.
 *
 * Examples of shell text:
 *   "Ani Filipova"  (author name, short)
 *   "View Ani Filipova's graphic link"
 *   "Open control menu for post by Ani Filipova"
 *   "Following"
 *   "1st"
 *   "Founder & CEO at SomeCompany"  (job title, usually short)
 *   "View Farzana Bhuiyan's profile ... reacted with EMPATHY"
 */
const POST_BODY_SHELL_PATTERNS = [
  /^view\s+.+('s\s+)?graphic\s+link$/i,
  /\breacted\s+with\s+/i,
  /^open\s+control\s+menu\s+for\s+post\s+by\b/i,
  /^hide\s+post\s+by\b/i,
  /^following$/i,
  /^1st(\+)?$|^2nd(\+)?$|^3rd(\+)?$/i,
  /^view\s+[\w\s.''-]+profile$/i,
  /^(like|comment|repost|send|share|save)$/i,
  /\bvisible to anyone\b/i,
  /\bpremium\b/i,
  /\bnewsletter\b/i,
];

/**
 * Check if text looks like prose-heavy authored content rather than
 * identity/meta/shell text. Prose has sentence structure: multiple words,
 * some punctuation or sentence-like length.
 */
function looksLikeProse(text) {
  if (text.length < BODY_MIN_PROSE_LENGTH) return false;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const wordCount = collapsed.split(/\s+/).filter(w => w.length > 1).length;
  if (wordCount < 5) return false;

  const hasSentencePunctuation = /[.!?]/.test(collapsed);
  const hasLineBreaks = /\n/.test(text);
  const bulletCount = (collapsed.match(/•/g) || []).length;
  const shellMarker = /\b(following|premium|visible to anyone|newsletter|author)\b/i.test(collapsed);

  if (shellMarker && !hasSentencePunctuation) return false;
  if (bulletCount >= 2 && !hasSentencePunctuation) return false;

  return hasSentencePunctuation || (hasLineBreaks && wordCount >= 12);
}

/**
 * Extract a clean post-body excerpt from snapshot elements for post-detail pages.
 *
 * Unlike buildLocalityAwareExcerpt (which scores all elements globally and sorts
 * by score), this function isolates the actual post body by:
 *   1. Finding the anchor (author byline / control menu)
 *   2. Skipping the author/header shell region immediately after the anchor
 *   3. Strongly preferring prose-like content AFTER the shell region
 *   4. Aggressively suppressing pre-anchor chrome
 *   5. Suppressing reaction/facepile/graphic-link/control-menu junk
 *   6. Requiring content to look like authored prose, not identity/meta text
 *
 * Returns the isolated body excerpt string, or '' if isolation fails.
 * Falls back to '' (not a noisy excerpt) — caller should use combinedExcerpt as fallback.
 */
function extractPostBodyExcerpt(snapshotElements, readUrl) {
  if (!Array.isArray(snapshotElements) || snapshotElements.length === 0) return '';

  // Only apply to post-type URLs
  let isPost = false;
  if (readUrl) {
    try {
      const pathname = new URL(readUrl).pathname;
      isPost = /^\/posts\//.test(pathname) ||
               /^\/pulse\//.test(pathname) ||
               /^\/feed\/update\//.test(pathname);
    } catch { /* skip */ }
  }
  if (!isPost) return '';

  const anchorIdx = findAnchorIndex(snapshotElements, readUrl);
  if (anchorIdx < 0) return '';

  // Infer the author name from the anchor so we can suppress byline mentions
  const inferred = inferAuthorFromSnapshot(snapshotElements);
  const authorNameLower = inferred ? inferred.authorName.toLowerCase() : null;

  const noiseTags = new Set(['button', 'input', 'textarea', 'select', 'nav', 'footer', 'header']);
  const seen = new Set();
  const bodyParts = [];

  // Walk elements in a tight window around the anchor, heavily biased AFTER it.
  // Post body typically appears in the ~20 elements after the author byline.
  // Pre-anchor elements are almost all chrome on post-detail pages.
  const preWindow = 3;   // very few pre-anchor elements allowed
  const postWindow = 25; // generous post-anchor window for full body
  const lo = Math.max(0, anchorIdx - preWindow);
  const hi = Math.min(snapshotElements.length - 1, anchorIdx + postWindow);

  // M15 Build 3: track whether we've seen the first prose block yet.
  // Elements before the first prose block in the post-anchor region are
  // treated as author shell (name, job title, "Following", etc.) and
  // held to a stricter standard.
  let seenFirstProse = false;

  for (let i = lo; i <= hi; i++) {
    const el = snapshotElements[i];
    const text = (el.text ?? '').trim();
    if (!text || text.length < 3) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    // Standard noise filtering
    if (noiseTags.has(el.tag) && text.length < 40) continue;
    if (isLinkedInNoise(text)) continue;
    if (el.tag === 'a' && text.length < ANCHOR_MIN_CONTENT_LENGTH) continue;

    // M15 Build 3: suppress post-body shell patterns everywhere in window
    if (POST_BODY_SHELL_PATTERNS.some(p => p.test(text))) continue;

    // Pre-anchor: aggressively suppress chrome patterns
    if (i < anchorIdx) {
      if (PRE_ANCHOR_CHROME_PATTERNS.some(p => p.test(text))) continue;
      // Only allow pre-anchor text if it's clearly prose-length
      if (text.length < BODY_MIN_PROSE_LENGTH) continue;
    }

    // Post-anchor region
    if (i > anchorIdx) {
      const isHeading = el.tag === 'h1' || el.tag === 'h2' || el.tag === 'h3';

      // M15 Build 3: Before we've seen the first prose block, we're in the
      // author shell zone. Suppress short non-prose text that's likely
      // author name, job title, connection degree, "Following", etc.
      if (!seenFirstProse) {
        // Author name suppression: if text is short and contains the author name
        if (authorNameLower && text.length < 80) {
          const textLower = text.toLowerCase();
          if (textLower.includes(authorNameLower) || authorNameLower.includes(textLower)) {
            continue;
          }
        }

        // In the shell zone, require prose-like structure or heading tag
        if (!isHeading && !looksLikeProse(text)) {
          continue;
        }
      }

      // Once we see a prose block or heading, we've exited the shell zone
      if (isHeading || looksLikeProse(text)) {
        seenFirstProse = true;
      }

      // Even after first prose, still require minimum length for non-headings
      if (!isHeading && text.length < BODY_MIN_PROSE_LENGTH) continue;
    }

    bodyParts.push(text);
  }

  if (bodyParts.length === 0) return '';

  const joined = bodyParts.join(' ');
  return buildExcerpt(joined);
}

const PAGE_TEXT_POST_TERMINATORS = [
  /^most relevant$/i,
  /^link here:/i,
  /^https?:\/\//i,
  /\bsubstack\.com\b/i,
  /^\d+\s*reactions?$/i,
  /^comments?$/i,
  /^follow$/i,
  /^following$/i,
  /^author$/i,
];

function looksLikePostBodyLine(line) {
  if (!line) return false;
  if (/^-\s+/.test(line)) return true;
  if (line.length < 30) return false;
  if (isLinkedInNoise(line)) return false;

  const wordCount = line.split(/\s+/).filter(w => w.length > 1).length;
  if (wordCount < 5) return false;

  return /[.!?:]/.test(line) || wordCount >= 10;
}

function extractPostBodyFromPageText(pageText, readUrl, authorName = null) {
  if (!pageText || !readUrl) return '';

  let isPost = false;
  try {
    const pathname = new URL(readUrl).pathname;
    isPost = /^\/posts\//.test(pathname) ||
             /^\/pulse\//.test(pathname) ||
             /^\/feed\/update\//.test(pathname);
  } catch {
    return '';
  }
  if (!isPost) return '';

  const lines = pageText
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  const authorLower = authorName ? authorName.toLowerCase() : null;
  let scanStart = 0;

  const feedPostIdx = lines.findIndex(line => /^feed\s+post$/i.test(line));
  if (feedPostIdx >= 0) scanStart = feedPostIdx + 1;

  if (authorLower) {
    const authorIdx = lines.findIndex((line, idx) => idx >= scanStart && line.toLowerCase().includes(authorLower));
    if (authorIdx >= 0) scanStart = authorIdx + 1;
  }

  let startIdx = -1;
  for (let i = scanStart; i < lines.length; i++) {
    if (looksLikePostBodyLine(lines[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return '';

  const bodyLines = [];
  let seenContentLines = 0;
  let seenNumericTail = 0;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    if (PAGE_TEXT_POST_TERMINATORS.some(pattern => pattern.test(line))) break;

    if (authorLower && seenContentLines >= 2 && lower.includes(authorLower)) break;

    if (/^\d+$/.test(line)) {
      seenNumericTail += 1;
      if (seenContentLines >= 2 && seenNumericTail >= 2) break;
      continue;
    }
    seenNumericTail = 0;

    if (seenContentLines >= 2 && /^[A-Z][\w.'’+-]*(\s+[A-Z][\w.'’+-]*){1,4}$/.test(line)) {
      break;
    }

    if (!looksLikePostBodyLine(line) && !/^-\s+/.test(line)) {
      if (seenContentLines >= 2) break;
      continue;
    }

    bodyLines.push(line);
    seenContentLines += 1;
  }

  if (bodyLines.length === 0) return '';
  return buildExcerpt(bodyLines.join(' '));
}

// ─── M15 Build 4: Post-body presence diagnosis ───

/**
 * Snapshot selector coverage — the tags actually queried by GET /page/snapshot.
 * This is the authoritative list from src/cdp/page.js SNAPSHOT_EXPRESSION.
 * Post body prose on LinkedIn typically lives in <p>, <div>, <span> — none of
 * which appear here.
 */
const SNAPSHOT_QUERIED_TAGS = new Set([
  'a', 'button', 'input', 'textarea', 'select', 'h1', 'h2', 'h3',
]);

/**
 * Extract likely prose sentences from pageText.
 * Returns an array of { sentence, charLen } for sentences that look like
 * authored content (≥ 30 chars, ≥ 5 words, not obvious chrome).
 */
function extractProseSentences(pageText) {
  if (!pageText) return [];
  // Split on newlines and sentence-ending punctuation
  const raw = pageText.split(/[\n]+/).map(s => s.trim()).filter(s => s.length >= 30);
  const sentences = [];
  for (const s of raw) {
    const wordCount = s.split(/\s+/).filter(w => w.length > 1).length;
    if (wordCount < 5) continue;
    if (isLinkedInNoise(s)) continue;
    sentences.push({ sentence: s, charLen: s.length });
  }
  return sentences;
}

/**
 * Diagnose whether the real post body prose is present in snapshotElements,
 * in pageText, both, or neither.
 *
 * This is the key investigative function for the M15 investigation pass.
 * It answers: "Why isn't the system grounding on the actual post body?"
 *
 * Returns {
 *   snapshotSelectorTags: string[],   — what tags the snapshot actually queries
 *   snapshotElementTags: object,      — distribution of tags in this snapshot
 *   missingFromSnapshot: string[],    — content-bearing tags NOT queried
 *   proseSentencesInPageText: number, — how many prose sentences found in pageText
 *   proseSentencesInSnapshot: number, — how many of those appear in snapshotElements
 *   proseCoverage: string,            — 'full' | 'partial' | 'none' | 'no_prose_found'
 *   sampleProseMissing: string[],     — up to 3 prose sentences NOT in snapshot (truncated)
 *   sampleProseFound: string[],       — up to 3 prose sentences found in snapshot (truncated)
 *   diagnosis: string,                — human-readable root cause summary
 * }
 */
function diagnosePostBodyPresence(snapshotElements, pageText) {
  const snapshotSelectorTags = [...SNAPSHOT_QUERIED_TAGS].sort();
  const missingContentTags = ['p', 'div', 'span', 'article', 'section', 'li', 'blockquote']
    .filter(t => !SNAPSHOT_QUERIED_TAGS.has(t));

  // Tag distribution in this snapshot
  const snapshotElementTags = {};
  const snapshotTexts = [];
  if (Array.isArray(snapshotElements)) {
    for (const el of snapshotElements) {
      const tag = el.tag ?? '(none)';
      snapshotElementTags[tag] = (snapshotElementTags[tag] ?? 0) + 1;
      const text = (el.text ?? '').trim();
      if (text.length >= 10) snapshotTexts.push(text.toLowerCase());
    }
  }

  // Extract prose sentences from pageText
  const proseSentences = extractProseSentences(pageText);

  if (proseSentences.length === 0) {
    return {
      snapshotSelectorTags,
      snapshotElementTags,
      missingFromSnapshot: missingContentTags,
      proseSentencesInPageText: 0,
      proseSentencesInSnapshot: 0,
      proseCoverage: 'no_prose_found',
      sampleProseMissing: [],
      sampleProseFound: [],
      diagnosis: 'no prose-like sentences detected in pageText — post body may not have loaded or page is not a content page',
    };
  }

  // Check which prose sentences appear in any snapshotElement text
  const found = [];
  const missing = [];
  for (const { sentence } of proseSentences) {
    const sentLower = sentence.toLowerCase();
    // Check if any snapshot element contains a significant substring of this sentence
    // (snapshot text is truncated to 120 chars, so we check substring containment)
    const inSnapshot = snapshotTexts.some(st =>
      st.includes(sentLower.slice(0, 80)) || sentLower.includes(st)
    );
    if (inSnapshot) {
      found.push(sentence);
    } else {
      missing.push(sentence);
    }
  }

  const proseCoverage = missing.length === 0 ? 'full'
    : found.length === 0 ? 'none'
    : 'partial';

  const truncSample = (arr, n) => arr.slice(0, n).map(s =>
    s.length > 100 ? s.slice(0, 100) + '…' : s
  );

  let diagnosis;
  if (proseCoverage === 'none') {
    diagnosis = `ROOT CAUSE: ${proseSentences.length} prose sentence(s) found in pageText but ZERO appear in snapshotElements. `
      + `The snapshot selector queries only [${snapshotSelectorTags.join(', ')}] — it does not capture [${missingContentTags.join(', ')}] `
      + `where LinkedIn post body prose lives. The post body is present in pageText but structurally absent from the snapshot element path.`;
  } else if (proseCoverage === 'partial') {
    diagnosis = `${found.length}/${proseSentences.length} prose sentences appear in snapshot (via headings or long anchor text). `
      + `${missing.length} prose sentences are missing — likely in <p>/<div>/<span> elements not captured by the snapshot selector.`;
  } else {
    diagnosis = `All ${proseSentences.length} prose sentences found in snapshot — snapshot coverage is sufficient for this page.`;
  }

  return {
    snapshotSelectorTags,
    snapshotElementTags,
    missingFromSnapshot: missingContentTags,
    proseSentencesInPageText: proseSentences.length,
    proseSentencesInSnapshot: found.length,
    proseCoverage,
    sampleProseMissing: truncSample(missing, 3),
    sampleProseFound: truncSample(found, 3),
    diagnosis,
  };
}

// ─── M15 Build 1: Single-post eligibility + commentability judgment ───

/**
 * Determine whether the current page is a single post-detail page.
 * Only post-detail pages are eligible for comment-prep — feed, profile,
 * and unknown pages are not.
 *
 * Returns { eligible: boolean, reason: string }.
 */
function isPostDetailPage(contextType, readUrl) {
  if (contextType === 'post' || contextType === 'thread') {
    return { eligible: true, reason: `page is a ${contextType} detail page` };
  }
  if (contextType === 'feed') {
    return { eligible: false, reason: 'feed pages contain multiple posts — navigate to a single post for comment-prep' };
  }
  if (contextType === 'profile') {
    return { eligible: false, reason: 'profile pages are not single-post contexts' };
  }
  return { eligible: false, reason: `context type "${contextType}" is not a recognized post-detail page` };
}

/**
 * Judge whether a post is worth commenting on.
 *
 * Evaluates content sufficiency, excerpt substance, and interaction signals
 * to produce an honest judgment. The system can — and should — say "no"
 * when a post is thin, unclear, or not worth engaging with.
 *
 * Inputs:
 *   - contentQuality: 'rich' | 'partial' | 'sparse'
 *   - combinedExcerpt: the best available excerpt text
 *   - signals: visibleSignals object
 *   - contextType: classified context type
 *
 * Returns {
 *   commentWorthy: boolean,
 *   confidence: 'high' | 'medium' | 'low',
 *   reasons: string[],       // why or why not
 * }
 */
function judgeCommentability({ contentQuality, combinedExcerpt, signals, contextType }) {
  const reasons = [];
  let score = 0;

  // --- Content sufficiency ---
  if (contentQuality === 'sparse') {
    reasons.push('content extraction is sparse — cannot reliably judge post substance');
    // Sparse content = low confidence regardless
    return { commentWorthy: false, confidence: 'low', reasons };
  }

  if (contentQuality === 'rich') {
    score += 2;
    reasons.push('rich content extracted — post substance is visible');
  } else {
    score += 1;
    reasons.push('partial content extracted — some post substance visible');
  }

  // --- Excerpt substance check ---
  const excerptLen = (combinedExcerpt ?? '').length;
  if (excerptLen < 40) {
    reasons.push('excerpt too short to judge post substance');
    return { commentWorthy: false, confidence: 'low', reasons };
  }

  // Check for substantive words (rough heuristic: sentences with real content)
  const wordCount = (combinedExcerpt ?? '').split(/\s+/).filter(w => w.length > 2).length;
  if (wordCount >= 20) {
    score += 2;
    reasons.push(`excerpt has ${wordCount} substantive words — enough to form a comment angle`);
  } else if (wordCount >= 8) {
    score += 1;
    reasons.push(`excerpt has ${wordCount} substantive words — limited but usable`);
  } else {
    reasons.push(`excerpt has only ${wordCount} substantive words — too thin for grounded comment`);
    return { commentWorthy: false, confidence: 'medium', reasons };
  }

  // --- Interaction signals ---
  if (signals.interactionOpportunities >= 2) {
    score += 1;
    reasons.push('multiple interaction affordances visible — post is actively engaging');
  } else if (signals.interactionOpportunities >= 1) {
    reasons.push('some interaction affordances visible');
  } else {
    reasons.push('no interaction affordances detected — post may be view-only or not fully loaded');
  }

  // --- Context type bonus ---
  if (contextType === 'thread') {
    score += 1;
    reasons.push('thread context — active discussion already present');
  }

  // --- Decision ---
  const commentWorthy = score >= 3;
  const confidence = score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low';

  if (!commentWorthy) {
    reasons.push('overall assessment: post does not meet threshold for comment-prep');
  }

  return { commentWorthy, confidence, reasons };
}

/**
 * Generate 1-2 grounded comment angles from the actual excerpt content.
 *
 * Unlike M14's generateDrafts (which produces template text), this function
 * extracts specific hooks from the excerpt that could anchor a real comment.
 *
 * Only called when judgeCommentability returns commentWorthy: true.
 *
 * Returns an array of { angle: string, grounding: string } objects.
 * angle = what kind of comment this would be
 * grounding = the specific excerpt content that anchors it
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanGroundingText(text, authorName = null) {
  if (!text) return '';
  let cleaned = text.replace(/\s+/g, ' ').trim();

  if (authorName) {
    const authorPattern = new RegExp(`\\s+${escapeRegex(authorName)}\\s*$`, 'i');
    cleaned = cleaned.replace(authorPattern, '').trim();
  }

  cleaned = cleaned.replace(/\s+(following|author|premium)\s*$/i, '').trim();
  cleaned = cleaned.replace(/\s+[•·|–—-]\s*$/u, '').trim();
  return cleaned;
}

function sentenceToClause(text) {
  if (!text) return '';
  let cleaned = cleanGroundingText(text)
    .replace(/^[-•]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = cleaned.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  cleaned = cleaned.replace(/[.!?…]+$/u, '').trim();

  if (!cleaned) return '';
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function startsLikeListIntro(text) {
  return /^(look at|here are|for example|examples?:|the biggest checks|link in comments)/i.test(text || '');
}

function scoreCommentSegment(text) {
  if (!text) return -Infinity;
  const normalized = cleanGroundingText(text);
  if (normalized.length < 20) return -Infinity;

  let score = 0;
  const lower = normalized.toLowerCase();
  score += Math.min(normalized.length, 180) / 18;

  if (/(what .* investors .* paying|where .* money went|one layer down|durable value|gap points somewhere interesting|mirror of where the money already went)/i.test(normalized)) score += 10;
  if (/\b(interesting|durable|value|signal|layer|money|investors|founders|pricing|wave|batch)\b/i.test(normalized)) score += 4;
  if (startsLikeListIntro(normalized)) score -= 6;
  if (/^link here:/i.test(normalized) || /substack\.com/i.test(normalized)) score -= 12;
  if (/^most relevant$/i.test(normalized)) score -= 12;
  if (/^\d+\s*(reactions?|comments?)$/i.test(normalized)) score -= 8;
  if (/^-\s+/.test(text)) score -= 2;
  if (normalized.length > 160) score -= 2;

  return score;
}

function buildHumanCommentDraft({ primary, secondary, mode = 'comment' }) {
  const joined = `${primary || ''} ${secondary || ''}`.toLowerCase();

  if (joined.includes('one layer down') && /founders|investors|money/.test(joined)) {
    if (mode === 'reply') {
      return 'The “one layer down” framing is the part that really lands for me. The gap between what founders are building and what investors are actually paying for feels like the more useful signal.';
    }
    return 'The “one layer down” framing is the part that really lands for me. The gap between what founders are building and what investors are actually paying for feels like the more useful signal.';
  }

  if (/open knowledge format|okf|markdown files|write one in a text editor|ai agents/.test(joined)) {
    if (mode === 'reply') {
      return 'This is the first framing of AI-readability infrastructure that feels practical to me. Once the standard is just markdown and a clear structure, it stops sounding like AI theater and starts looking like normal web plumbing.';
    }
    return 'This is the first framing of AI-readability infrastructure that feels practical to me. Once the standard is just markdown and a clear structure, it stops sounding like AI theater and starts looking like normal web plumbing.';
  }

  if (/investor money went|founders were building|investors were paying for/.test(joined)) {
    if (mode === 'reply') {
      return 'This is the right read. The gap between what everyone says they’re building and what investors are actually paying for is a much better signal than the surface AI-agent narrative.';
    }
    return 'This is the right read. The gap between what everyone says they’re building and what investors are actually paying for is a much better signal than the surface AI-agent narrative.';
  }

  const primaryClause = sentenceToClause(primary);
  const secondaryClause = sentenceToClause(secondary);

  if (mode === 'reply') {
    return secondaryClause
      ? `What stands out to me is ${primaryClause}. Feels like the more important point is ${secondaryClause}. Curious if that’s how you see it too.`
      : `What stands out to me is ${primaryClause}. Curious if that’s how you see it too.`;
  }

  return secondaryClause
    ? `What stands out to me is ${primaryClause}. The sharper point is ${secondaryClause}.`
    : `What stands out to me is ${primaryClause}.`;
}

function generateCommentAngles(combinedExcerpt, contextType) {
  const angles = [];
  if (!combinedExcerpt || combinedExcerpt.length < 30) return angles;

  // Split excerpt into sentence-like segments
  const segments = combinedExcerpt
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 15);

  if (segments.length === 0) return angles;

  const rankedSegments = [...segments]
    .map(segment => ({ segment, score: scoreCommentSegment(segment) }))
    .sort((a, b) => b.score - a.score);

  const strongest = rankedSegments[0]?.segment ?? segments[0];
  const strongestTrunc = strongest.length > 120 ? strongest.slice(0, 120) + '…' : strongest;
  angles.push({
    angle: 'substantive response',
    grounding: strongestTrunc,
  });

  // Angle 2: Follow-up question if there are multiple distinct segments
  // (suggests the post has enough depth for a question)
  if (segments.length >= 2) {
    // Find a different segment from the strongest
    const other = rankedSegments.find(({ segment }) => segment !== strongest && segment.length >= 15)?.segment;
    if (other) {
      const otherTrunc = other.length > 120 ? other.slice(0, 120) + '…' : other;
      angles.push({
        angle: contextType === 'thread' ? 'thread follow-up' : 'follow-up question',
        grounding: otherTrunc,
      });
    }
  }

  return angles;
}

function buildFollowUpBrief({ selectedTab, readUrl, pageText, snapshotText = '', rawSnapshotText = '', snapshotElements = [], localSnapshotText = '', localRawSnapshotText = '', localSnapshotElements = [], mode = 'inspect_only' }) {
  const isLinkedIn = isLinkedInUrl(readUrl);

  // Use raw (unfiltered) snapshot text for signal extraction so that chrome words
  // like "comment" and "reply" are still visible to the signal detector.
  // The filtered snapshotText is used only for excerpts and length reporting.
  const signalText = rawSnapshotText || snapshotText;
  const bestText = (pageText.length < 50 && signalText.length > pageText.length) ? signalText : pageText;
  // Use the full snapshot for excerpt grounding on post/thread pages.
  // The author-centered local snapshot is useful for author inference, but it is
  // too easy for byline/profile shell to dominate the excerpt when comments are present.
  const excerptSnapshotElements = snapshotElements.length > 0 ? snapshotElements : localSnapshotElements;
  const excerptSnapshotText = snapshotText || localSnapshotText;
  const signals = extractVisibleSignals(bestText);
  const contextType = classifyLinkedInContext(readUrl, bestText);
  const notes = [];
  const limitations = [];

  notes.push('read-only inspection — no mutations performed');
  notes.push('signal extraction is heuristic text matching, not DOM analysis');
  notes.push(`context classified as "${contextType}" from URL path`);

  if (mode === 'draft_only') {
    notes.push('draft_only mode — drafts are candidate text only, never submitted');
  }

  if (!isLinkedIn) {
    limitations.push('readUrl does not appear to be a LinkedIn page — signals may be inaccurate');
  }
  if (contextType === 'feed') {
    limitations.push('feed context is generic — for better results, navigate to a specific post or thread');
  }
  if (contextType === 'unknown') {
    limitations.push('context type could not be determined from URL — inspection may be less useful');
  }
  limitations.push('page text may not reflect dynamically loaded content (comments behind "show more", etc.)');
  limitations.push('auth-gated content may not be visible depending on session state');

  const excerpt = buildExcerpt(pageText);
  const inferredAuthor = inferAuthorFromSnapshot(localSnapshotElements) ?? inferAuthorFromSnapshot(snapshotElements);
  const contentExcerpt = excerptSnapshotElements.length > 0
    ? buildLocalityAwareExcerpt(excerptSnapshotElements, readUrl)
    : '';
  const combinedExcerpt = cleanGroundingText(
    contentExcerpt.length > 0 ? contentExcerpt : excerpt,
    inferredAuthor?.authorName ?? null,
  );

  // M15 Build 2: Isolated post-body excerpt for cleaner grounding.
  // This is a tighter extraction that strongly favors post-anchor prose
  // and aggressively suppresses pre-anchor chrome, sidebar, and promo text.
  const postBodyExcerpt = cleanGroundingText(
    extractPostBodyFromPageText(pageText, readUrl, inferredAuthor?.authorName ?? null) ||
      (excerptSnapshotElements.length > 0
        ? extractPostBodyExcerpt(excerptSnapshotElements, readUrl)
        : ''),
    inferredAuthor?.authorName ?? null,
  );

  // For commentability/angles, use the cleaner postBodyExcerpt when available,
  // falling back to combinedExcerpt only when body isolation didn't produce results.
  const groundingExcerpt = postBodyExcerpt.length > 0 ? postBodyExcerpt : combinedExcerpt;

  const contentQuality = computeContentQuality(Math.max(pageText.length, excerptSnapshotText.length));

  if (contentQuality === 'sparse') {
    limitations.push('content extraction was sparse — post/thread text may not have loaded fully');
  }
  if (snapshotText && snapshotText.length > pageText.length) {
    notes.push('snapshot provided richer content than innerText — used for signal extraction');
  }
  if (localSnapshotElements.length > 0) {
    notes.push('captured author-centered local snapshot for author inference/debugging');
  }

  // Determine suggested mode based on context
  let suggestedMode = 'inspect_only';
  if ((contextType === 'post' || contextType === 'thread') && signals.interactionOpportunities >= 1) {
    suggestedMode = 'draft_only';
  }

  // M15 Build 1: Eligibility + commentability judgment
  // Build 2: uses groundingExcerpt (postBodyExcerpt when available) instead of combinedExcerpt
  const eligibility = isPostDetailPage(contextType, readUrl);
  let commentability = null;
  let commentAngles = [];

  if (eligibility.eligible) {
    commentability = judgeCommentability({ contentQuality, combinedExcerpt: groundingExcerpt, signals, contextType });
    if (commentability.commentWorthy) {
      commentAngles = generateCommentAngles(groundingExcerpt, contextType);
    }
  }

  const brief = {
    ok: true,
    target: {
      id: selectedTab.id,
      title: selectedTab.title ?? null,
      url: selectedTab.url ?? null,
    },
    followUp: {
      surface: 'linkedin',
      contextType,
      postContext: {
        readUrl,
        title: selectedTab.title ?? null,
        textLength: pageText.length,
        excerpt,
        contentQuality,
        snapshotTextLength: snapshotText.length,
        localSnapshotTextLength: localSnapshotText.length,
        combinedExcerpt,
        postBodyExcerpt,
      },
      eligibility,
      commentability,
      commentAngles,
      visibleSignals: signals,
      suggestedMode,
      drafts: [],
      notes,
      limitations,
    },
  };

  if (mode === 'draft_only') {
    brief.followUp.drafts = generateDrafts({
      contextType,
      excerpt: groundingExcerpt,
      signals,
      title: selectedTab.title ?? null,
      commentAngles,
    });
  }

  return brief;
}

function selectTab(allTabs, { targetId, matchUrl, matchTitle }, stderr) {
  if (targetId) {
    const tab = allTabs.find((t) => t.id === targetId) ?? null;
    if (!tab) {
      stderr.write(`  [FAIL] target selection: no tab with id "${targetId}"\n`);
      stderr.write(`  available ids: ${allTabs.map((t) => t.id).join(', ') || 'none'}\n`);
      return null;
    }
    return tab;
  }

  if (matchUrl) {
    const matches = allTabs.filter((t) => t.url?.includes(matchUrl));
    if (matches.length === 0) {
      stderr.write(`  [FAIL] target selection: no tab with URL containing "${matchUrl}"\n`);
      stderr.write(`  available URLs: ${allTabs.map((t) => t.url).join(', ') || 'none'}\n`);
      return null;
    }
    if (matches.length > 1) {
      stderr.write(`  [FAIL] target selection: ${matches.length} tabs match URL "${matchUrl}" — be more specific or use --target-id\n`);
      for (const m of matches) stderr.write(`    id=${m.id}  url=${m.url}\n`);
      return null;
    }
    return matches[0];
  }

  const matches = allTabs.filter((t) => t.title?.includes(matchTitle));
  if (matches.length === 0) {
    stderr.write(`  [FAIL] target selection: no tab with title containing "${matchTitle}"\n`);
    stderr.write(`  available titles: ${allTabs.map((t) => t.title).join(', ') || 'none'}\n`);
    return null;
  }
  if (matches.length > 1) {
    stderr.write(`  [FAIL] target selection: ${matches.length} tabs match title "${matchTitle}" — be more specific or use --target-id\n`);
    for (const m of matches) stderr.write(`    id=${m.id}  title=${m.title}\n`);
    return null;
  }
  return matches[0];
}

export async function runLinkedInFollowUpBrief({
  adapter,
  args = {},
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { targetId = null, matchUrl = null, matchTitle = null, mode = 'inspect_only', debug = false } = args;
  const logger = createLogger(stdout, stderr);

  // Validate mode
  if (!VALID_MODES.includes(mode)) {
    stderr.write(`[linkedin-followup] error: invalid mode "${mode}" — must be one of: ${VALID_MODES.join(', ')}\n`);
    return { exitCode: 1, brief: null };
  }

  const selectors = [targetId, matchUrl, matchTitle].filter(Boolean);
  if (selectors.length === 0) {
    stderr.write('[linkedin-followup] error: specify one of --target-id, --match-url, or --match-title\n');
    stderr.write('  example: --match-url "linkedin.com"\n');
    return { exitCode: 1, brief: null };
  }
  if (selectors.length > 1) {
    stderr.write('[linkedin-followup] error: specify only one of --target-id, --match-url, or --match-title\n');
    return { exitCode: 1, brief: null };
  }

  stdout.write('=== LinkedIn Follow-up Brief (M14 Build 4) ===\n');
  stdout.write(`bridge: ${args.baseUrl ?? 'http://127.0.0.1:7820'}\n`);
  stdout.write(`mode: ${mode}\n`);
  if (targetId) stdout.write(`select: --target-id ${targetId}\n`);
  else if (matchUrl) stdout.write(`select: --match-url "${matchUrl}"\n`);
  else stdout.write(`select: --match-title "${matchTitle}"\n`);
  stdout.write('\n');

  // Step 1: health
  try {
    const { status, body } = await adapter.health();
    if (status === 200 && body?.ok) {
      logger.ok('health', 'bridge reachable');
    } else {
      logger.fail('health', `status=${status} ok=${body?.ok}`);
      stderr.write('\n[linkedin-followup] bridge not reachable — is it running?\n');
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('health', `unreachable: ${err.message}`);
    stderr.write(`\n[linkedin-followup] bridge not reachable — is it running on ${args.baseUrl ?? 'http://127.0.0.1:7820'}?\n`);
    return { exitCode: 1, brief: null };
  }

  // Step 2: state
  let controlState = null;
  try {
    const { status, body } = await adapter.state();
    if (status === 200) {
      controlState = body.controlState;
      logger.ok('state', controlState);
    } else {
      logger.fail('state', `status=${status}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('state', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 3: recover if needed
  if (controlState === 'ERROR' || controlState === 'DETACHED') {
    try {
      const { status, body } = await adapter.recover();
      if (status === 200) {
        controlState = body.controlState;
        logger.ok('recover', `-> ${controlState}`);
      } else {
        logger.fail('recover', `status=${status} code=${body?.code}`);
        return { exitCode: 1, brief: null };
      }
    } catch (err) {
      logger.fail('recover', err.message);
      return { exitCode: 1, brief: null };
    }
  }

  if (controlState !== 'ATTACHED' && controlState !== 'PAUSED') {
    logger.fail('pre-adopt state', `unexpected state: ${controlState}; expected ATTACHED or PAUSED`);
    return { exitCode: 1, brief: null };
  }

  // Step 4: enumerate tabs
  let allTabs = [];
  try {
    const { status, body } = await adapter.tabs();
    if (status === 200 && body?.ok) {
      allTabs = body.tabs ?? [];
      logger.ok('tabs', `${allTabs.length} open tab${allTabs.length !== 1 ? 's' : ''}`);
    } else {
      logger.fail('tabs', `status=${status} code=${body?.code}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('tabs', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 5: select target deterministically
  const selectedTab = selectTab(allTabs, { targetId, matchUrl, matchTitle }, stderr);
  if (!selectedTab) {
    return { exitCode: 1, brief: null };
  }
  logger.ok('target selected', `"${selectedTab.title ?? '(no title)'}": id=${selectedTab.id}`);

  // Step 6: pause if ATTACHED (skip if already PAUSED)
  if (controlState === 'ATTACHED') {
    try {
      const { status, body } = await adapter.pause({ reason: 'linkedin-followup-inspection' });
      if (status === 200) {
        logger.ok('pause', `-> ${body.controlState}`);
      } else {
        logger.fail('pause', `status=${status} code=${body?.code}`);
        return { exitCode: 1, brief: null };
      }
    } catch (err) {
      logger.fail('pause', err.message);
      return { exitCode: 1, brief: null };
    }
  } else {
    logger.ok('pause', 'skipped (already PAUSED)');
  }

  // Step 7: adopt the selected target explicitly
  let adoptedTarget = null;
  try {
    const { status, body } = await adapter.resume({ adoptTargetId: selectedTab.id });
    if (status === 200 && body?.ok) {
      adoptedTarget = body.adoptedTarget ?? null;
      logger.ok('adopt', `adoptTargetId=${selectedTab.id} -> ${body.controlState}`);
    } else {
      logger.fail('adopt', `status=${status} code=${body?.code} error=${body?.error}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('adopt', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 8: verify adoption
  if (!adoptedTarget) {
    logger.fail('verify adoption', 'adoptedTarget absent from response — adoption not confirmed by id');
    return { exitCode: 1, brief: null };
  }
  if (adoptedTarget.id !== selectedTab.id) {
    logger.fail('verify adoption', `adopted id ${adoptedTarget.id} does not match intended ${selectedTab.id}`);
    return { exitCode: 1, brief: null };
  }
  logger.ok('verify adoption', `adopted id matches intended (${adoptedTarget.id})`);

  // Step 9a: read URL of the adopted target
  let readUrl = null;
  try {
    const { status, body } = await adapter.url();
    if (status === 200 && body?.url) {
      readUrl = body.url;
      logger.ok('read/url', readUrl);
    } else {
      logger.fail('read/url', `status=${status} code=${body?.code}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('read/url', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 9b: read page text of the adopted target
  let pageText = null;
  try {
    const { status, body } = await adapter.text();
    if (status === 200 && typeof body?.text === 'string') {
      pageText = body.text;
      logger.ok('read/text', `${pageText.length} chars`);
    } else {
      logger.fail('read/text', `status=${status} code=${body?.code}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('read/text', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 9c: read snapshot for richer extraction (graceful degradation if unavailable)
  let snapshotText = '';
  let rawSnapshotText = '';
  let snapshotElements = [];
  try {
    const { status, body } = await adapter.snapshot();
    if (status === 200 && Array.isArray(body?.snapshot)) {
      snapshotElements = body.snapshot;
      snapshotText = extractSnapshotText(snapshotElements);
      rawSnapshotText = extractRawSnapshotText(snapshotElements);
      logger.ok('read/snapshot', `${snapshotElements.length} elements, ${snapshotText.length} chars filtered, ${rawSnapshotText.length} chars raw`);
    } else {
      logger.ok('read/snapshot', 'skipped (unavailable or empty)');
    }
  } catch (err) {
    logger.ok('read/snapshot', `skipped (${err.message})`);
  }

  // Step 9d: try an author-centered local snapshot for cleaner post grounding
  let localSnapshotText = '';
  let localRawSnapshotText = '';
  let localSnapshotElements = [];
  const inferredAuthor = inferAuthorFromSnapshot(snapshotElements);
  if (inferredAuthor?.authorName) {
    try {
      const { status, body } = await adapter.localSnapshot({ anchorText: inferredAuthor.authorName });
      if (status === 200 && Array.isArray(body?.snapshot)) {
        localSnapshotElements = body.snapshot;
        localSnapshotText = extractSnapshotText(localSnapshotElements);
        localRawSnapshotText = extractRawSnapshotText(localSnapshotElements);
        logger.ok('read/local-snapshot', `${localSnapshotElements.length} elements around "${inferredAuthor.authorName}", ${localSnapshotText.length} chars filtered`);
      } else {
        logger.ok('read/local-snapshot', `skipped (status=${status})`);
      }
    } catch (err) {
      logger.ok('read/local-snapshot', `skipped (${err.message})`);
    }
  } else {
    logger.ok('read/local-snapshot', 'skipped (no inferred author anchor)');
  }

  // Step 9e: debug dump of snapshot internals (--debug only)
  if (debug) {
    const debugDump = buildSnapshotDebugDump(snapshotElements, snapshotText, rawSnapshotText, pageText);
    stdout.write('\n--- Debug: Snapshot Inspection ---\n');
    stdout.write(JSON.stringify(debugDump, null, 2));
    stdout.write('\n--- End Debug: Snapshot Inspection ---\n\n');

    // Step 9f: anchor cluster debug — local neighborhood around matched anchor
    const clusterDebug = buildAnchorClusterDebug(snapshotElements, readUrl);
    stdout.write('--- Debug: Anchor Cluster ---\n');
    stdout.write(JSON.stringify(clusterDebug, null, 2));
    stdout.write('\n--- End Debug: Anchor Cluster ---\n\n');

    // Step 9g (Build 10): comparative candidate cluster debug
    // Dumps the local neighborhood for EVERY candidate anchor, not just the winner.
    // Answers: "Is the target post body absent near its candidate, or present but outscored?"
    const comparativeDebug = buildComparativeCandidateDebug(snapshotElements);
    stdout.write('--- Debug: Comparative Candidate Clusters (Build 10) ---\n');
    stdout.write(JSON.stringify(comparativeDebug, null, 2));
    stdout.write('\n--- End Debug: Comparative Candidate Clusters ---\n\n');
  }

  // Step 10: build structured follow-up brief
  const brief = buildFollowUpBrief({
    selectedTab,
    readUrl,
    pageText,
    snapshotText,
    rawSnapshotText,
    snapshotElements,
    localSnapshotText,
    localRawSnapshotText,
    localSnapshotElements,
    mode,
  });

  stdout.write('\nPASS — LinkedIn follow-up brief produced\n');
  stdout.write(`  context type: ${brief.followUp.contextType}\n`);
  stdout.write(`  mode: ${mode}\n`);
  if (mode === 'draft_only') {
    stdout.write(`  drafts generated: ${brief.followUp.drafts.length}\n`);
  }
  stdout.write(`  suggested mode: ${brief.followUp.suggestedMode}\n`);
  stdout.write('\nWhat this workflow proved:\n');
  stdout.write('  - bridge reachable and responding\n');
  stdout.write('  - GET /tabs enumerates open tabs with ids, URLs, and titles\n');
  stdout.write('  - target selected deterministically by explicit selector\n');
  stdout.write('  - adoptTargetId confirmed by response body (adoptedTarget.id verified)\n');
  stdout.write('  - GET /page/url and GET /page/text completed after adoption\n');
  stdout.write('  - structured LinkedIn follow-up brief produced with visible signal extraction\n');
  stdout.write('  - URL-based context classification (feed/post/thread/profile/unknown)\n');
  if (mode === 'draft_only') {
    stdout.write('  - draft candidates generated without any public submission\n');
  }
  stdout.write('\nWhat this workflow did NOT prove:\n');
  stdout.write('  - signal extraction is heuristic — it searches page text, not DOM structure\n');
  stdout.write('  - dynamically loaded content (comments behind "show more") may be missed\n');
  stdout.write('  - this is read-only — no mutations or public actions were performed\n');
  stdout.write('  - context classification is URL-based, not DOM-verified\n');
  if (mode === 'draft_only') {
    stdout.write('  - drafts are candidate text only — they were NOT submitted or typed anywhere\n');
  }

  stdout.write('\n--- LinkedIn Follow-up Brief (JSON) ---\n');
  stdout.write(JSON.stringify(brief, null, 2));
  stdout.write('\n--- End ---\n');

  try {
    const { status, body } = await adapter.pause({ reason: 'linkedin-followup-complete' });
    if (status === 200) {
      logger.ok('pause (handoff)', `-> ${body.controlState}`);
    } else {
      logger.fail('pause (handoff)', `status=${status} code=${body?.code} — bridge left ATTACHED`);
    }
  } catch (err) {
    logger.fail('pause (handoff)', `${err.message} — bridge left ATTACHED`);
  }

  return { exitCode: 0, brief };
}

// Exported for testing
export { isLinkedInUrl, extractVisibleSignals, classifyLinkedInContext, generateDrafts, extractSnapshotText, extractRawSnapshotText, buildSnapshotDebugDump, buildAnchorClusterDebug, buildComparativeCandidateDebug, isLinkedInNoise, computeContentQuality, scoreContentElement, buildFollowUpBrief, buildContentFocusedExcerpt, buildLocalityAwareExcerpt, extractPostBodyExcerpt, extractPostBodyFromPageText, extractPostAnchorFromUrl, findAnchorIndex, inferAuthorFromSnapshot, collectAllAuthorCandidates, scoreCandidateCluster, disambiguateCandidateAnchors, isPostDetailPage, judgeCommentability, generateCommentAngles, LOCALITY_WINDOW, LOCALITY_BONUS, CANDIDATE_CLUSTER_WINDOW, VALID_MODES };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const adapterOpts = { baseUrl: parsedArgs.baseUrl };
  if (parsedArgs.token) {
    const tok = parsedArgs.token;
    adapterOpts.fetchImpl = (url, init = {}) => {
      const headers = { ...(init.headers ?? {}), Authorization: `Bearer ${tok}` };
      return globalThis.fetch(url, { ...init, headers });
    };
  }
  const adapter = createOpenClawAdapter(adapterOpts);
  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: parsedArgs });
  process.exitCode = exitCode;
}
