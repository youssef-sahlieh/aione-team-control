import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./test/approval-e2e',workers:1,reporter:'list',use:{baseURL:'http://localhost:3101',browserName:'chromium',trace:'retain-on-failure'},webServer:{command:JSON.stringify(process.execPath)+' scripts/approval-preview.js',url:'http://localhost:3101',env:{PREVIEW_PORT:'3101'},reuseExistingServer:false}});
