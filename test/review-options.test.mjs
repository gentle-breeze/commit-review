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
test('plural Tests suffix filters Java only and preserves filename semantics',()=>{
  for(const name of ['FooTests.java','src/FooTests.java','Tests.java','deleted/OldTests.java'])assert.equal(isTestFile(name),true,name);
  for(const name of ['FooTests.ts','FooTests.kt','FooTests','Footests.java','FooTests.JAVA','FooTests.java.bak','Tests/Foo.java','FooTestsHelper.java'])assert.equal(isTestFile(name),false,name);
  const files=[{id:'ordinary',path:'Foo.java',oldPath:'FooTests.java'},{id:'renamed',path:'NewTests.java',oldPath:'Old.java'},{id:'deleted',path:'DeletedTests.java',status:'D'},{id:'typescript',path:'FooTests.ts'}];
  assert.deepEqual(visibleFiles(files,true).map(f=>f.id),['ordinary','typescript']);
  assert.equal(visibleFiles(files,false),files,'opt-out retains the complete original list');
  assert.equal(files.length,4,'filtering does not mutate input');
  assert.deepEqual(visibleFiles([{path:'FooTests.java'},{path:'BarTest.java'}],true),[]);
});
test('skip Test preference defaults on and preserves explicit project opt-outs',()=>{
  const storage=new Map();storage.getItem=storage.get.bind(storage);
  assert.equal(readSkipTestFiles(storage,'/A'),true);
  storage.set(skipTestFilesKey('/A'),'true');
  assert.equal(readSkipTestFiles(storage,'/A'),true);
  assert.equal(readSkipTestFiles(storage,'/B'),true);
  storage.set(skipTestFilesKey('/A'),'false');
  assert.equal(readSkipTestFiles(storage,'/A'),false);
  assert.equal(readSkipTestFiles(storage,'/B'),true);
  assert.equal(storage.get(skipTestFilesKey('/A')),'false','reading does not overwrite explicit choice');
  storage.set(skipTestFilesKey('/A'),'invalid');assert.equal(readSkipTestFiles(storage,'/A'),true);
  storage.getItem=()=>null;assert.equal(readSkipTestFiles(storage,'/A'),true);
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
