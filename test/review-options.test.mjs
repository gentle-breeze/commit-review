import test from 'node:test';
import assert from 'node:assert/strict';
import {isTestFile, visibleFiles, skipTestFilesKey, readSkipTestFiles, focusShortcut} from '../public/review-options.js';
test('Test filtering matches only a case-sensitive basename stem suffix',()=>{
  for(const name of ['FooTest.java','src/FooTest.tsx','FooTest','Test','.FooTest','deleted/OldTest.kt'])assert.equal(isTestFile(name),true,name);
  for(const name of ['TestHelper.java','FooTestHelper.js','Test/Foo.java','Footest.java','FooTest.spec.ts','Test.md.txt','contest.js'])assert.equal(isTestFile(name),false,name);
  const files=[{id:'1',path:'Foo.java',oldPath:'FooTest.java'},{id:'2',path:'NewTest.java',oldPath:'Old.java'},{id:'3',path:'DeletedTest.java',status:'D'}];
  assert.deepEqual(visibleFiles(files,true).map(f=>f.id),['1']);
  assert.deepEqual(visibleFiles(files,false),files);
  assert.equal(files.length,3);
});
test('skip Test preference defaults off and isolates canonical project keys',()=>{
  const storage=new Map();storage.getItem=storage.get.bind(storage);
  assert.equal(readSkipTestFiles(storage,'/A'),false);
  storage.set(skipTestFilesKey('/A'),'true');
  assert.equal(readSkipTestFiles(storage,'/A'),true);
  assert.equal(readSkipTestFiles(storage,'/B'),false);
  storage.set(skipTestFilesKey('/A'),'invalid');assert.equal(readSkipTestFiles(storage,'/A'),false);
});
test('physical F accepts idle IME 229 only outside editing and actual composition',()=>{
  for(const key of ['f','F','Process','ｆ'])assert.equal(focusShortcut({key,code:'KeyF',keyCode:229}),true);
  assert.equal(focusShortcut({key:'f',code:'KeyG'}),false);
  assert.equal(focusShortcut({key:'f'}),true);
  assert.equal(focusShortcut({key:'f',keyCode:229}),false);
  for(const field of ['isComposing','defaultPrevented','ctrlKey','metaKey','altKey','shiftKey'])assert.equal(focusShortcut({code:'KeyF',[field]:true}),false,field);
  assert.equal(focusShortcut({code:'KeyF'},{editing:true}),false);
  assert.equal(focusShortcut({code:'KeyF'},{composing:true}),false);
});
