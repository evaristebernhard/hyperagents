import { test, expect } from "@playwright/test";
const password = "synthetic-menu-e2e-password";
async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/threads/new");
  await page.getByLabel("Password",{exact:true}).fill(password);
  const create=page.getByRole("button",{name:"Create owner account",exact:true});
  if(await create.count()){await page.getByLabel("Confirm password",{exact:true}).fill(password);await create.click();}
  else await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await expect(page.getByLabel("Task prompt",{exact:true})).toBeVisible();
}
async function openPicker(page: import("@playwright/test").Page) {
  await page.getByRole("button",{name:"Model settings",exact:true}).click();
  await page.getByRole("menu",{name:"Model settings menu"}).locator('[data-submenu="tools"]').click();
  return page.getByRole("menu",{name:"tools options"});
}
test("server-backed menu distinguishes unavailable from available and can toggle a configured tool",async({page})=>{
 await signIn(page); const picker=await openPicker(page);
 const img=picker.getByRole("menuitemcheckbox",{name:"Images",exact:true});
 await expect(img).toBeDisabled(); await expect(img).toHaveAttribute("title",/No executor/);
 const tables=picker.getByRole("menuitemcheckbox",{name:"Tables",exact:true});
 await expect(tables).toBeEnabled(); const before=await tables.getAttribute("aria-checked"); await tables.click(); await expect(tables).toHaveAttribute("aria-checked",before==="true"?"false":"true");
});
test("capability endpoint failure never enables a previously unselected unavailable tool",async({page})=>{
 await signIn(page); await page.route("**/api/capabilities",route=>route.fulfill({status:503,body:"unavailable"})); await page.reload();
 const picker=await openPicker(page); await expect(picker).toContainText("Availability could not be checked");
 await expect(picker.getByRole("menuitemcheckbox",{name:"Images",exact:true})).toBeDisabled();
});
