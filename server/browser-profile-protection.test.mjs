import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateDataRequest } from '../scripts/private-data.mjs';
test('browser credential profiles cannot be served by the development server',()=>{
 for(const path of ['/.browser-profiles/identity/Cookies','/%2ebrowser-profiles/identity/Local%20State','/@fs/profiles/identity/Cookies','/backend/.data-v1/profiles/identity/Cookies'])assert.equal(isPrivateDataRequest(path),true,path);
 assert.equal(isPrivateDataRequest('/src/BrowserPanel.tsx'),false);
});
