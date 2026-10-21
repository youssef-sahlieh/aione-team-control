import {test,expect} from '@playwright/test';

test('developer posts an internal note that mentions an admin, and admins can read it',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/preview/user');
  await page.goto('/dashboard.html?page=tickets#AION-102');
  await page.getByRole('tab',{name:'Internal notes',exact:true}).click();
  const input=page.locator('#ticket-note-text');
  await input.fill('@Preview');
  await expect(page.locator('#panel-notes .mention-picker').getByRole('option',{name:'Preview Admin',exact:true})).toBeVisible();
  await input.press('Enter');
  await input.press('End');
  await input.pressSequentially('Please review the deployment blocker before tomorrow.');
  await page.getByRole('button',{name:'Add note',exact:true}).click();
  await expect(page.locator('#panel-notes')).toContainText('Note posted. 1 person notified.');
  await expect(page.locator('#panel-notes')).toContainText('Please review the deployment blocker before tomorrow.');
  await expect(page.locator('#panel-notes')).toContainText('Mentioned: @Preview Admin');
  await page.getByRole('tab',{name:'Comments',exact:true}).click();
  await expect(page.locator('#panel-comments')).not.toContainText('Please review the deployment blocker before tomorrow.');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.goto('/preview/admin');
  await page.goto('/dashboard.html?page=tickets#AION-102');
  await page.getByRole('tab',{name:'Internal notes',exact:true}).click();
  await expect(page.locator('#panel-notes')).toContainText('Preview Developer · builder');
  await expect(page.locator('#panel-notes')).toContainText('Please review the deployment blocker before tomorrow.');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/internal-notes-mobile.png',fullPage:true});
  expect(errors).toEqual([]);
});

test('missing live date-request route explains deployment rather than displaying Not found',async({page})=>{
  await page.route('**/api/date-requests',route=>route.fulfill({status:404,json:{code:'not_found',error:'Not found.'}}));
  await page.goto('/preview/admin');await page.goto('/dashboard.html?page=requests');
  await expect(page.getByText('The connected backend has not been updated for ticket business fields, clients, reports, date requests, and internal notes.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry loading requests',exact:true})).toBeVisible();
});

for (const width of [320,1440]) test(`user posts an internal note from the ticket at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.goto('/preview/user');await page.goto('/dashboard.html?page=tickets');
  await page.getByRole('button',{name:'Internal note for AION-102',exact:true}).click();
  await expect(page.locator('#drawer')).toBeVisible();
  await expect(page.getByRole('tab',{name:'Internal notes',exact:true})).toHaveAttribute('aria-selected','true');
  await page.locator('#ticket-note-text').fill('Please review my deployment question '+width);
  await page.getByRole('button',{name:'Add note',exact:true}).click();
  await expect(page.locator('#panel-notes')).toContainText('Please review my deployment question '+width);
  await expect(page.locator('#panel-notes')).toContainText('Note posted.');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
