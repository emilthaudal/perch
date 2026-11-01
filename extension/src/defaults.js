// Shared by the page script, the content script and the popup.
globalThis.PERCH_DEFAULTS = Object.freeze({
  // "likes" | "engagement" (likes + 2×replies + reposts) | "off" (X's own order)
  sortMode: 'likes',
  // Divide a blue-check reply's score by this, so it needs N× the likes to rank
  // the same. "1" turns it off, "bottom" sinks them below everyone else.
  bluePenalty: '3',
  // Replies from people you follow go above everything except the author's own.
  boostFollowing: true,
  removeAds: true,
  followingTab: true,
  // Hide the "What's happening?" box on the home timeline.
  hideComposer: true,
  styling: true,
});
