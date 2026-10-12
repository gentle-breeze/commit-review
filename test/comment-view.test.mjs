import test from 'node:test';
import assert from 'node:assert/strict';
import { commentRevision, reviewComments, nextReviewComment } from '../public/comment-view.js';
test('comment visibility, counts and traversal use the same filtered order', () => {
  const comments = [{id:'a',sha:'hidden',resolved:false},{id:'b',sha:'visible',resolved:true},{id:'c',sha:'visible',resolved:false}];
  const options={hidden:new Set(['hidden']),showingHidden:false,scope:'all',sha:'visible',filter:'all'};
  const visible=reviewComments(comments,options);
  assert.deepEqual(visible.map(c=>c.id),['c','b']);
  assert.equal(nextReviewComment(visible,null).id,'c');
  assert.equal(nextReviewComment(visible,'c').id,'b');
  assert.equal(nextReviewComment(visible,'b'),null);
  assert.equal(nextReviewComment([],null),null);
  assert.deepEqual(reviewComments(comments,{...options,filter:'open'}).map(c=>c.id),['c']);
  assert.deepEqual(reviewComments(comments,{...options,showingHidden:true}).map(c=>c.id),['a']);
  assert.deepEqual(reviewComments(comments,{...options,scope:'commit',sha:'hidden'}),[]);
  assert.equal(comments.length,3);
});
test('read revision changes on new replies, edits and reopening, not on rerender', () => {
  const comment={id:'a',body:'body',resolved:false,replies:[]};
  const original=commentRevision(comment);
  assert.equal(commentRevision(structuredClone(comment)),original);
  assert.notEqual(commentRevision({...comment,replies:[{id:'r',body:'reply',author:'ai'}]}),original);
  assert.notEqual(commentRevision({...comment,body:'edited'}),original);
  assert.notEqual(commentRevision({...comment,resolvedAt:'reopened'}),original);
  assert.equal(commentRevision({...comment,updatedAt:'no visible change'}),original);
});
