import { test, expect } from "@playwright/test";
test("tool picker groups chips and preserves selection and keyboard semantics", async ({ page }) => {
  await page.goto("/threads/new");
  await page.getByRole("button", {name:"Model settings",exact:true}).click();
  const menu=page.getByRole("menu",{name:"Model settings menu"});
  await menu.locator('[data-submenu="tools"]').click();
  const picker=page.getByRole("menu",{name:"tools options"});
  for(const name of ["Research","Browser","Data","Interactive","Media","Workspace"]) await expect(picker.getByRole("group",{name,exact:true})).toBeAttached();
  const browser=picker.getByRole("menuitemcheckbox",{name:"Browser",exact:true});
  await expect(browser).toHaveAttribute("aria-checked","true");
  await browser.click(); await expect(browser).toHaveAttribute("aria-checked","false");
  await expect(browser).not.toHaveClass(/selected/);
  await page.keyboard.press("Escape"); await expect(menu.locator('[data-submenu="tools"]')).toBeFocused();
});
test("tool picker remains within a narrow viewport",async({page})=>{
 await page.setViewportSize({width:390,height:700}); await page.goto("/threads/new");
 await page.getByRole("button",{name:"Model settings",exact:true}).click();
 await page.getByRole("menu",{name:"Model settings menu"}).locator('[data-submenu="tools"]').click();
 const box=await page.getByRole("menu",{name:"tools options"}).boundingBox();
 expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x+box!.width).toBeLessThanOrEqual(390); expect(box!.y+box!.height).toBeLessThanOrEqual(700);
});
