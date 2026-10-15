import {test,expect} from '@playwright/test';

test('developer sends a private ticket note that admins can read',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/preview/user');
  await page.goto('/dashboard.html?page=tickets#AION-102');
  await page.getByRole('tab',{name:'Internal notes',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:'Ellen',exact:true})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'Youssef',exact:true})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'Karim',exact:true})).toBeChecked();
  await page.getByRole('checkbox',{name:'Youssef',exact:true}).uncheck();
  await page.getByLabel('Note to admins',{exact:true}).fill('Please review the deployment blocker before tomorrow.');
  await page.getByRole('button',{name:'Send to admins',exact:true}).click();
  await expect(page.locator('#panel-notes')).toContainText('Note saved and emailed to admins.');
  await expect(page.locator('#panel-notes')).toContainText('Please review the deployment blocker before tomorrow.');
  await expect(page.locator('#panel-notes')).toContainText('Sent to: Preview Admin, Ellen, Karim');
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
  await page.goto('/preview/admin');
  await expect(page.getByText('The connected backend has not been updated for date requests and internal notes.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry loading requests',exact:true})).toBeVisible();
});

for (const width of [320,1440]) test(`user has the admin-style note composer at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.goto('/preview/user');await page.goto('/dashboard.html?page=tickets');
  await page.getByRole('button',{name:'Internal note for AION-102',exact:true}).click();
  const composer=page.locator('#pop');await expect(composer).toContainText('Internal note · AION-102');
  await expect(composer.getByRole('button',{name:'Ellen',exact:true})).toBeVisible();await expect(composer.getByRole('button',{name:'Youssef',exact:true})).toBeVisible();await expect(composer.getByRole('button',{name:'Karim',exact:true})).toBeVisible();
  const ellen=composer.getByRole('button',{name:'Ellen',exact:true});
  const selectedColor=await ellen.evaluate(button=>getComputedStyle(button).color);
  expect(selectedColor).not.toBe('rgb(255, 255, 255)');
  expect(await ellen.evaluate(button=>getComputedStyle(button).backgroundColor)).not.toBe(selectedColor);
  await ellen.click();await expect(ellen).toHaveAttribute('aria-pressed','false');await expect(ellen).toHaveCSS('color',selectedColor);
  await ellen.click();await expect(ellen).toHaveAttribute('aria-pressed','true');await expect(ellen).toHaveCSS('color',selectedColor);
  await composer.getByLabel('Subject',{exact:true}).fill('Deployment question');await composer.getByLabel('Note',{exact:true}).fill('Please review my deployment question '+width);
  await composer.getByRole('checkbox',{name:'Include ticket details and link'}).uncheck();
  await composer.getByRole('button',{name:'Send email',exact:true}).click();await expect(composer).toBeHidden();
  await page.goto('/dashboard.html?page=tickets#AION-102');await page.getByRole('tab',{name:'Internal notes',exact:true}).click();await expect(page.locator('#panel-notes')).toContainText('Please review my deployment question '+width);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
