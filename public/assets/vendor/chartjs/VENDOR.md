# Chart.js (vendored)

- Package: chart.js 4.4.7, MIT licence (see LICENSE.md)
- Source: `npm pack chart.js@4.4.7`, file `package/dist/chart.umd.js`, copied unchanged
- SHA-256: 2812cb8825fdc57469eb2f7bb055e9429244e599920511ee477e828499b632cb
- Why vendored: the dashboard's Content Security Policy only allows scripts from its own origin.
- Loaded only by the Analytics page (public/assets/components/analytics-charts.js), so other pages never download it.
- To upgrade: pack the new version, replace the file, update the version and hash above; test/analytics-vendor.test.js checks they match.
