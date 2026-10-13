export const activeFollowups = comment => (comment.followups || []).filter(link => !link.removedAt);
export const commentShas = comment => [...new Set([comment.sha,...activeFollowups(comment).map(link=>link.sha)])];
// Read state belongs to this page only; no review data is written.
export function commentRevision(comment) {
  return JSON.stringify([comment.body, comment.resolved, comment.resolvedAt,
    comment.linkRevision || 0, (comment.replies || []).map(reply => [reply.id, reply.body, reply.author])]);
}
export function reviewComments(comments, {hidden, showingHidden, scope, sha, filter}) {
  return comments.filter(comment => commentShas(comment).some(value => hidden.has(value) === showingHidden && (scope === 'all' || value === sha)) &&
    (filter === 'all' || comment.resolved === (filter === 'resolved'))).slice().reverse();
}
export function nextReviewComment(comments, currentId) {
  return comments[comments.findIndex(comment => comment.id === currentId) + 1] || null;
}
