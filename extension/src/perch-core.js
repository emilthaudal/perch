// Pure functions that rewrite X's GraphQL responses before the page renders them.
// Loaded into the page (MAIN world) and required by the Node tests.
(function (root) {
  'use strict';

  const GRAPHQL_OP = /\/graphql\/[^/]+\/([A-Za-z0-9_]+)/;

  function operationName(url) {
    const m = GRAPHQL_OP.exec(String(url || ''));
    return m ? m[1] : null;
  }

  function focalIdFromUrl(url) {
    try {
      const vars = new URL(url, 'https://x.com').searchParams.get('variables');
      if (!vars) return null;
      const parsed = JSON.parse(vars);
      return parsed.focalTweetId ?? parsed.focal_tweet_id ?? null;
    } catch {
      return null;
    }
  }

  // X's responses used camelCase keys (entryId, sortIndex, itemContent) until a
  // November 2026 redesign moved to snake_case (entry_id, sort_index, and the
  // item's content under `content`). These helpers read either shape.
  function idOf(entry) {
    return entry?.entryId ?? entry?.entry_id;
  }

  function sortIndexOf(entry) {
    return entry?.sortIndex ?? entry?.sort_index;
  }

  function setSortIndex(entry, value) {
    if ('sort_index' in entry && !('sortIndex' in entry)) entry.sort_index = value;
    else entry.sortIndex = value;
  }

  // The item payload of an entry (content.itemContent / content.content) or of a
  // module item (item.itemContent / item.content).
  function itemContentOf(holder) {
    if (!holder) return undefined;
    if (holder.itemContent) return holder.itemContent;
    const inner = holder.content;
    return inner && typeof inner === 'object' && !Array.isArray(inner) && !inner.items ? inner : undefined;
  }

  function unwrapTweet(result) {
    return result && result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  }

  function isPromoted(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const id = idOf(entry);
    if (typeof id === 'string' && /(^|-)promoted-/.test(id)) return true;
    const itemContent = itemContentOf(entry.content) ?? itemContentOf(entry.item);
    if (itemContent?.promotedMetadata || itemContent?.promoted_metadata) return true;
    // X injects ads into threads as reply modules that hold only a promoted tweet.
    // Dropping just the tweet would leave an empty module behind, so drop the module.
    const items = entry.content?.items;
    return Array.isArray(items) && items.length > 0 && items.every(isPromoted);
  }

  // Removes promoted entries anywhere in the response. Returns how many it removed.
  function stripAds(node) {
    let removed = 0;
    if (Array.isArray(node)) {
      for (const child of node) removed += stripAds(child);
      return removed;
    }
    if (!node || typeof node !== 'object') return 0;
    for (const key of ['entries', 'items', 'moduleItems', 'module_items']) {
      const list = node[key];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((e) => !isPromoted(e));
      removed += list.length - kept.length;
      node[key] = kept;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') removed += stripAds(value);
    }
    return removed;
  }

  function firstTweetOfModule(entry) {
    return unwrapTweet(itemContentOf(entry?.content?.items?.[0]?.item)?.tweet_results?.result);
  }

  function authorOf(tweet) {
    return tweet?.core?.user_results?.result ?? null;
  }

  // Higher tier always wins; score breaks ties inside a tier.
  function rankReply(entry, settings, focalAuthorId) {
    const tweet = firstTweetOfModule(entry);
    if (!tweet) return { tier: 2, score: 0 };

    const user = authorOf(tweet);
    const following = Boolean(user?.relationship_perspectives?.following ?? user?.legacy?.following);
    const blue = Boolean(user?.is_blue_verified ?? user?.verification?.is_blue_verified);
    const counts = tweet.counts ?? tweet.legacy ?? {};
    const likes = counts.favorite_count || 0;

    let score = likes;
    if (settings.sortMode === 'engagement') {
      score += 2 * (counts.reply_count || 0) + (counts.retweet_count || 0) + (counts.quote_count || 0);
    }

    if (user?.rest_id && user.rest_id === focalAuthorId) return { tier: 4, score };
    if (following && settings.boostFollowing) return { tier: 3, score };
    if (blue && !following) {
      if (settings.bluePenalty === 'bottom') return { tier: 1, score };
      score /= Number(settings.bluePenalty) || 1;
    }
    return { tier: 2, score };
  }

  function compareSortIndexDesc(a, b) {
    try {
      const x = BigInt(a);
      const y = BigInt(b);
      return x > y ? -1 : x < y ? 1 : 0;
    } catch {
      return String(b).localeCompare(String(a));
    }
  }

  // X's client orders timeline entries by sortIndex, not by array position, so we
  // hand the existing sortIndex values out again in our order and also reorder the array.
  function sortReplyEntries(entries, settings, focalAuthorId) {
    const positions = [];
    entries.forEach((e, i) => {
      const id = idOf(e);
      if (typeof id === 'string' && id.startsWith('conversationthread-')) positions.push(i);
    });
    if (positions.length < 2) return false;

    const modules = positions.map((i) => entries[i]);
    const sortIndexes = modules.map(sortIndexOf).sort(compareSortIndexDesc);
    const ranked = modules
      .map((m, i) => ({ m, i, r: rankReply(m, settings, focalAuthorId) }))
      .sort((a, b) => b.r.tier - a.r.tier || b.r.score - a.r.score || a.i - b.i);

    ranked.forEach(({ m }, k) => {
      setSortIndex(m, sortIndexes[k]);
      entries[positions[k]] = m;
    });
    return true;
  }

  // focalAuthors caches focal tweet id -> author id, because "load more replies"
  // pages don't include the focal tweet.
  function sortReplies(json, focalId, settings, focalAuthors) {
    const instructions = json?.data?.threaded_conversation_with_injections_v2?.instructions;
    if (!Array.isArray(instructions)) return false;

    const addEntries = instructions.filter(
      (i) => (i?.type ?? i?.__typename) === 'TimelineAddEntries' && Array.isArray(i.entries),
    );
    for (const instr of addEntries) {
      const focal = instr.entries.find((e) => idOf(e) === `tweet-${focalId}`);
      const id = authorOf(unwrapTweet(itemContentOf(focal?.content)?.tweet_results?.result))?.rest_id;
      if (id && focalId) focalAuthors.set(focalId, id);
    }
    const focalAuthorId = focalAuthors.get(focalId) ?? null;

    let changed = false;
    for (const instr of addEntries) {
      changed = sortReplyEntries(instr.entries, settings, focalAuthorId) || changed;
    }
    return changed;
  }

  // Mutates json in place. Returns true when anything changed; fills `stats` for logging.
  function transform(json, url, settings, focalAuthors, stats = {}) {
    const op = operationName(url);
    if (!op || !json || typeof json !== 'object') return false;
    stats.op = op;
    stats.adsRemoved = settings.removeAds ? stripAds(json) : 0;
    stats.repliesSorted = false;
    if (op === 'TweetDetail' && settings.sortMode !== 'off') {
      stats.repliesSorted = sortReplies(json, focalIdFromUrl(url), settings, focalAuthors);
    }
    return stats.adsRemoved > 0 || stats.repliesSorted;
  }

  const api = { operationName, focalIdFromUrl, stripAds, rankReply, sortReplies, transform };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PerchCore = api;
})(globalThis);
