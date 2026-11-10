import {test} from "node:test";
import assert from "node:assert/strict";
import {replyPreview, commentAuthor, signatureNode, newSendId, keepSendId, replySentText} from "../../public/assets/models/comment-reply.js";

test("the preview is one short line of the comment, Hebrew and emoji kept whole",()=>{
  assert.equal(replyPreview("Line one\n\nline   two"),"Line one line two");
  assert.equal(replyPreview("שלום ".repeat(60),20),"שלום שלום שלום שלום…");
  assert.equal(replyPreview("😀".repeat(200),5),"😀😀😀😀😀…");
  assert.equal(replyPreview(""),"");
});

test("the Jira author stays the author; the dashboard sender is shown apart and is who a reply goes to",()=>{
  assert.deepEqual(commentAuthor({author:{displayName:"Dana Client"}}),{jiraName:"Dana Client",submitter:"",replyName:"Dana Client"});
  assert.deepEqual(commentAuthor({author:{displayName:"AION Bot"}},"Ellen"),{jiraName:"AION Bot",submitter:"Ellen",replyName:"Ellen"});
  assert.equal(commentAuthor({}).jiraName,"Someone");
});

test("the trailing '— Name' line is hidden only when it names the dashboard sender already shown",()=>{
  const body=(last)=>({lastElementChild:last?{textContent:last}:null});
  const b=body(" — Ellen ");
  assert.equal(signatureNode(b,"Ellen"),b.lastElementChild);
  assert.equal(signatureNode(body("— Sam"),"Ellen"),null);
  assert.equal(signatureNode(body("— Ellen"),""),null);
  assert.equal(signatureNode(body(null),"Ellen"),null);
});

test("a send's id is kept when Jira may have it (no answer, server error, still sending) and dropped after a refusal",()=>{
  assert.match(newSendId(),/^[\w-]{8,64}$/); assert.notEqual(newSendId(),newSendId());
  assert.equal(keepSendId({code:"network",status:0}),true);
  assert.equal(keepSendId({code:"jira",status:502}),true);
  assert.equal(keepSendId({code:"comment_pending",status:409}),true);
  assert.equal(keepSendId({code:"reply_target_unavailable",status:404}),false);
  assert.equal(keepSendId({code:"bad_request",status:400}),false);
});

test("after a reply: who was answered, whether they were mentioned, and any restriction kept",()=>{
  assert.equal(replySentText({to:"Dana",mentioned:true,restricted:""}),"Reply sent to Dana's comment. Dana was mentioned in Jira.");
  assert.equal(replySentText({to:"Ellen",mentioned:false,restricted:""},["Ellen"]),"Reply sent to Ellen's comment. Ellen couldn't be mentioned in Jira, but got a dashboard notification.");
  assert.equal(replySentText({to:"Lead",mentioned:true,restricted:"Visible only to Developers (role)"}),"Reply sent to Lead's comment. Lead was mentioned in Jira. Visible only to Developers (role), like the comment it answers.");
});
