import {test,expect} from '@playwright/test';
test('developer requests a date and admin approves it in the local backend',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/preview/user');await expect(page.getByRole('heading',{name:'Overview',exact:true})).toBeVisible();
 await page.goto('/dashboard.html?page=tickets#AION-102');await expect(page.locator('#d-due')).toBeDisabled();const before=await page.locator('#d-due').inputValue();
 await page.getByRole('button',{name:'Request date change',exact:true}).click();
 const dialog=page.locator('dialog.date-dialog');await expect(dialog).toBeVisible();
 await dialog.getByLabel('Requested date',{exact:true}).fill('2026-12-12');await dialog.getByLabel('Reason (required)',{exact:true}).fill('Need more time to test the new retry behavior.');
 await dialog.getByRole('button',{name:'Submit request',exact:true}).click();await expect(dialog).not.toBeVisible();
 await expect(page.locator('#d-date-requests')).toContainText('Awaiting approval');await expect(page.locator('#d-due')).toHaveValue(before);
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.goto('/preview/admin');
 const card=page.locator('.date-request-card').filter({hasText:'AION-102'});await expect(card).toBeVisible();await page.screenshot({path:'test-results/date-requests-desktop.png',fullPage:true});await card.getByRole('button',{name:'Approve',exact:true}).click();
 await page.locator('dialog.date-dialog').getByRole('button',{name:'Approve and apply date',exact:true}).click();await expect(page.locator('dialog.date-dialog')).not.toBeVisible();
 await page.goto('/dashboard.html?page=tickets#AION-102');await expect(page.locator('#d-due')).toHaveValue('2026-12-12');await expect(page.locator('#d-date-requests')).toContainText('Approved');
 expect(errors).toEqual([]);await page.screenshot({path:'test-results/date-approved-desktop.png',fullPage:true});
});
test('approval inbox and request form fit mobile; user cannot bypass permissions',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});await page.goto('/preview/admin');await expect(page.getByRole('heading',{name:'Date requests',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/date-requests-mobile.png',fullPage:true});
 await page.goto('/preview/user');await page.goto('/dashboard.html?page=tickets#AION-105');await page.locator('#d-requestdate').click();const dialog=page.locator('dialog.date-dialog');await expect(dialog).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/date-request-form-mobile.png',fullPage:true});await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
 const denied=await page.evaluate(async()=>{const s=JSON.parse(localStorage.getItem('aione-session'));return (await fetch('/api/jira/issue/AION-105',{method:'PUT',headers:{Authorization:'Bearer '+s.token,'Content-Type':'application/json'},body:JSON.stringify({fields:{duedate:'2026-12-31'}})})).status;});expect(denied).toBe(403);expect(errors).toEqual([]);
});

test('developer sets first date immediately, then submits later changes for approval',async({page})=>{
 await page.goto('/preview/user');await page.goto('/dashboard.html?page=tickets#AION-105');await page.getByRole('button',{name:'Set due date',exact:true}).click();const dialog=page.locator('dialog.date-dialog');await expect(dialog.getByRole('heading')).toHaveText('Set initial due date');await dialog.getByLabel('Requested date',{exact:true}).fill('2026-12-15');await expect(dialog.getByLabel('Remove the due date')).toBeHidden();await dialog.getByRole('button',{name:'Set due date',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(page.locator('#d-due')).toHaveValue('2026-12-15');await expect(page.locator('#d-date-requests')).toContainText('Initial date set');
 await page.getByRole('button',{name:'Request date change',exact:true}).click();await dialog.getByLabel('Requested date',{exact:true}).fill('2026-12-20');await dialog.getByLabel('Reason (required)',{exact:true}).fill('Need additional verification time');await dialog.getByRole('button',{name:'Submit request',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(page.locator('#d-due')).toHaveValue('2026-12-15');await expect(page.locator('#d-date-requests')).toContainText('Awaiting approval');
});

test('admins filter by the requesting developer and do not have a Mine view',async({page})=>{
 await page.goto('/preview/admin');await expect(page.getByRole('button',{name:'Mine',exact:true})).toHaveCount(0);
 await expect(page.locator('.date-request-card').filter({hasText:'AION-103'})).toContainText('Requested by Preview Reviewer (reviewer)');
 const select=page.getByRole('combobox',{name:'Requesting developer',exact:true});await select.selectOption('reviewer@aione.biz');await expect(page.locator('.date-request-card')).toHaveCount(1);await expect(page.locator('.date-request-card')).toContainText('AION-103');
 await select.selectOption('builder@aione.biz');await expect(page.locator('.date-request-card').filter({hasText:'AION-103'})).toHaveCount(0);await expect(page.locator('.date-request-card').first()).toContainText('Requested by Preview Developer (builder)');
 await page.getByRole('button',{name:'Decisions',exact:true}).click();await expect(page.locator('.date-request-card').filter({hasText:'AION-104'})).toBeVisible();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.goto('/preview/user');await page.goto('/dashboard.html?page=requests');await expect(page.getByRole('button',{name:'Mine',exact:true})).toBeVisible();await expect(page.getByRole('combobox',{name:'Requesting developer',exact:true})).toHaveCount(0);
});
