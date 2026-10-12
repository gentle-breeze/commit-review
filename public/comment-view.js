// Read state belongs to this page only; no review data is written.
export function commentRevision(comment) {
  return JSON.stringify([comment.body, comment.resolved, comment.resolvedAt,
    (comment.replies || []).map(reply => [reply.id, reply.body, reply.author])]);
}
export function reviewComments(comments, {hidden, showingHidden, scope, sha, filter}) {
  return comments.filter(comment => hidden.has(comment.sha) === showingHidden &&
    (scope === 'all' || comment.sha === sha) &&
    (filter === 'all' || comment.resolved === (filter === 'resolved'))).slice().reverse();
}
export function nextReviewComment(comments, currentId) {
  return comments[comments.findIndex(comment => comment.id === currentId) + 1] || null;
}
