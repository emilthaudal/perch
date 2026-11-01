// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/src/perch-core.js');

const DEFAULTS = {
  sortMode: 'likes',
  bluePenalty: '3',
  boostFollowing: true,
  removeAds: true,
};

const FOCAL_ID = '1000';
const OP_ID = 'op';
const URL = `https://x.com/i/api/graphql/abc123/TweetDetail?variables=${encodeURIComponent(
  JSON.stringify({ focalTweetId: FOCAL_ID }),
)}`;

function tweet(id, user, counts = {}) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    core: {
      user_results: {
        result: {
          rest_id: user.id,
          is_blue_verified: Boolean(user.blue),
          relationship_perspectives: { following: Boolean(user.following) },
        },
      },
    },
    legacy: { favorite_count: 0, reply_count: 0, retweet_count: 0, quote_count: 0, ...counts },
  };
}

function reply(id, sortIndex, user, counts) {
  return {
    entryId: `conversationthread-${id}`,
    sortIndex,
    content: {
      entryType: 'TimelineTimelineModule',
      items: [{ entryId: `conversationthread-${id}-tweet-${id}`, item: { itemContent: { tweet_results: { result: tweet(id, user, counts) } } } }],
    },
  };
}

function threadResponse(replies, { withFocal = true, extra = [] } = {}) {
  const entries = [];
  if (withFocal) {
    entries.push({
      entryId: `tweet-${FOCAL_ID}`,
      sortIndex: '9999',
      content: { itemContent: { tweet_results: { result: tweet(FOCAL_ID, { id: OP_ID }) } } },
    });
  }
  entries.push(...replies, ...extra, { entryId: 'cursor-bottom-1', sortIndex: '1' });
  return { data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries }] } } };
}

function replyOrder(json) {
  const entries = json.data.threaded_conversation_with_injections_v2.instructions[0].entries;
  const byArray = entries.filter((e) => e.entryId.startsWith('conversationthread-')).map((e) => e.entryId.split('-')[1]);
  const bySortIndex = entries
    .filter((e) => e.entryId.startsWith('conversationthread-'))
    .sort((a, b) => (BigInt(b.sortIndex) > BigInt(a.sortIndex) ? 1 : -1))
    .map((e) => e.entryId.split('-')[1]);
  assert.deepEqual(byArray, bySortIndex, 'array order and sortIndex order must agree');
  return byArray;
}

test('ranks author, then people you follow, then likes with a blue-check penalty', () => {
  const json = threadResponse([
    reply('blueBig', '900', { id: 'b1', blue: true }, { favorite_count: 120 }),
    reply('plain', '800', { id: 'p1' }, { favorite_count: 50 }),
    reply('friend', '700', { id: 'f1', following: true }, { favorite_count: 2 }),
    reply('opSelf', '600', { id: OP_ID }, { favorite_count: 0 }),
    reply('blueSmall', '500', { id: 'b2', blue: true }, { favorite_count: 30 }),
    reply('quiet', '400', { id: 'q1' }, { favorite_count: 1 }),
  ]);

  assert.equal(core.transform(json, URL, DEFAULTS, new Map()), true);
  // blueBig: 120/3 = 40 sits below plain (50); blueSmall: 30/3 = 10.
  assert.deepEqual(replyOrder(json), ['opSelf', 'friend', 'plain', 'blueBig', 'blueSmall', 'quiet']);
});

test('a blue check with far more likes still wins', () => {
  const json = threadResponse([
    reply('plain', '900', { id: 'p1' }, { favorite_count: 50 }),
    reply('blueHuge', '800', { id: 'b1', blue: true }, { favorite_count: 600 }),
  ]);
  core.transform(json, URL, DEFAULTS, new Map());
  assert.deepEqual(replyOrder(json), ['blueHuge', 'plain']);
});

test('"bottom" sinks blue checks below everyone, but not people you follow', () => {
  const json = threadResponse([
    reply('blueHuge', '900', { id: 'b1', blue: true }, { favorite_count: 600 }),
    reply('blueFriend', '800', { id: 'b2', blue: true, following: true }, { favorite_count: 1 }),
    reply('quiet', '700', { id: 'q1' }, { favorite_count: 0 }),
  ]);
  core.transform(json, URL, { ...DEFAULTS, bluePenalty: 'bottom' }, new Map());
  assert.deepEqual(replyOrder(json), ['blueFriend', 'quiet', 'blueHuge']);
});

test('engagement mode counts replies and reposts', () => {
  const json = threadResponse([
    reply('likes', '900', { id: 'a' }, { favorite_count: 10 }),
    reply('discussed', '800', { id: 'b' }, { favorite_count: 4, reply_count: 5 }),
  ]);
  core.transform(json, URL, { ...DEFAULTS, sortMode: 'engagement' }, new Map());
  assert.deepEqual(replyOrder(json), ['discussed', 'likes']);
});

test('"load more" pages without the focal tweet still put the author first', () => {
  const focalAuthors = new Map();
  core.transform(threadResponse([reply('x', '9', { id: 'a' }), reply('y', '8', { id: 'b' })]), URL, DEFAULTS, focalAuthors);

  const page2 = threadResponse(
    [reply('popular', '300', { id: 'p' }, { favorite_count: 99 }), reply('opLate', '200', { id: OP_ID })],
    { withFocal: false },
  );
  core.transform(page2, URL, DEFAULTS, focalAuthors);
  assert.deepEqual(replyOrder(page2), ['opLate', 'popular']);
});

test('sortMode off leaves X order alone', () => {
  const json = threadResponse([
    reply('a', '900', { id: 'a' }, { favorite_count: 1 }),
    reply('b', '800', { id: 'b' }, { favorite_count: 99 }),
  ]);
  assert.equal(core.transform(json, URL, { ...DEFAULTS, sortMode: 'off', removeAds: false }, new Map()), false);
  assert.deepEqual(replyOrder(json), ['a', 'b']);
});

test('removes promoted entries and promoted items inside modules', () => {
  const promotedTweet = {
    entryId: 'promoted-tweet-555',
    sortIndex: '850',
    content: { itemContent: { promotedMetadata: { advertiser: 'x' }, tweet_results: { result: tweet('555', { id: 'ad' }) } } },
  };
  const json = threadResponse([reply('a', '900', { id: 'a' }), reply('b', '800', { id: 'b' })], { extra: [promotedTweet] });
  const module = json.data.threaded_conversation_with_injections_v2.instructions[0].entries[1];
  module.content.items.push({ entryId: 'x', item: { itemContent: { promotedMetadata: {} } } });

  core.transform(json, URL, DEFAULTS, new Map());
  const entries = json.data.threaded_conversation_with_injections_v2.instructions[0].entries;
  assert.equal(entries.some((e) => e.entryId.startsWith('promoted')), false);
  assert.equal(entries.find((e) => e.entryId === 'conversationthread-a').content.items.length, 1);
});

test('ads disguised as reply modules are dropped whole, not left empty', () => {
  // Shape taken from a real TweetDetail response: a reply module whose only item is promoted.
  const adModule = {
    entryId: 'conversationthread-2100267880579555546',
    sortIndex: '850',
    content: {
      entryType: 'TimelineTimelineModule',
      items: [
        {
          entryId: 'conversationthread-2100267880579555546-promoted-tweet-2100267880579555546-4b253e6df43cdbc1',
          item: { itemContent: { promotedMetadata: {}, tweet_results: { result: tweet('210', { id: 'ad' }, { favorite_count: 538 }) } } },
        },
      ],
    },
  };
  const json = threadResponse([reply('a', '900', { id: 'a' }), adModule, reply('b', '800', { id: 'b' }, { favorite_count: 3 })]);
  const stats = {};
  core.transform(json, URL, DEFAULTS, new Map(), stats);
  assert.equal(stats.adsRemoved, 1);
  assert.deepEqual(replyOrder(json), ['b', 'a']);
});

test('home timeline ads are removed, other operations are untouched by sorting', () => {
  const home = {
    data: {
      home: {
        home_timeline_urt: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [
                { entryId: 'tweet-1', content: { itemContent: {} } },
                { entryId: 'promoted-tweet-2', content: { itemContent: {} } },
                { entryId: 'tweet-3', content: { itemContent: { promotedMetadata: {} } } },
              ],
            },
          ],
        },
      },
    },
  };
  const url = 'https://x.com/i/api/graphql/zzz/HomeLatestTimeline?variables=%7B%7D';
  assert.equal(core.transform(home, url, DEFAULTS, new Map()), true);
  assert.deepEqual(home.data.home.home_timeline_urt.instructions[0].entries.map((e) => e.entryId), ['tweet-1']);
});

test('non-GraphQL URLs are ignored', () => {
  assert.equal(core.operationName('https://x.com/home'), null);
  assert.equal(core.transform({ entries: [{ entryId: 'promoted-tweet-1' }] }, 'https://x.com/home', DEFAULTS, new Map()), false);
});

test('TweetWithVisibilityResults wrappers are unwrapped', () => {
  const json = threadResponse([reply('a', '900', { id: 'a' }, { favorite_count: 1 }), reply('b', '800', { id: 'b' }, { favorite_count: 9 })]);
  const item = json.data.threaded_conversation_with_injections_v2.instructions[0].entries[2].content.items[0].item.itemContent;
  item.tweet_results.result = { __typename: 'TweetWithVisibilityResults', tweet: item.tweet_results.result };
  core.transform(json, URL, DEFAULTS, new Map());
  assert.deepEqual(replyOrder(json), ['b', 'a']);
});
