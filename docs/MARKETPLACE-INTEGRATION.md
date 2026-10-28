# Marketplace integration: observed inventory and executable coverage

Baseline: main already contained commit 75d8cfb; no pending PR required merging. Original obsolete branches were not merged or overwritten.

## Scope and provenance

Read-only browser inspection on 2026-10-28 found 36 unique skills and 25 unique agents across 8 category pages. Category membership overlaps; 119 category rows deduplicate to 61 entries. This is a dated snapshot, not a live sync guarantee. Source links and publisher names identify the originals. Descriptions here are short independently written summaries. No original account was modified or hired into, and no private prompts, downloaded scripts, signed images, reviews or installation counts were redistributed.

Thirteen independently authored implementations are supplied: eleven skill workflows and two agent prompts. Some intentionally implement only a disclosed subset of the original package. These are not official publisher packages or feature-identical copies. Entries without an implementation remain source listings and cannot install a fake skill. The replica does not claim that cataloguing an item implements it.

## Actual install-to-execution path

Marketplace search/type/category/readiness filters -> detail and exact instruction preview -> explicit installation -> SQLite save acknowledgement -> installed Skill/Agent -> composer context selection -> required tool preferences -> DeepSeek instructions and tool definitions -> actual tool result -> saved document/webpage/table and tool history.

Installation is deduplicated by source ID for skills and deterministic installation ID for agents. Reopening preserves edits and does not silently unarchive an existing item. All data stays in the selected workspace. Failed saves do not navigate or report success. Importing a user-owned Markdown/JSON skill remains available through Skills; original publisher scripts do not execute merely because a skill describes them.

## API adapters

- World Bank: fixed HTTPS Indicators v2 endpoint, one country/indicator, bounded annual rows, no key. A live request from this sandbox received an upstream WAF 403 on 2026-10-28; no fallback/example data was returned. Adapter parsing/limits pass mocked tests, but reachability needs verification on the deployment server. Do not call it live-verified here.
- NWS: fixed points -> forecast endpoints; forecast URL restricted to the exact API host/path. Live request for demonstration coordinates 38.8977,-77.0365 returned actual Washington DC forecast periods. This was not the user's inferred location. US coverage only, coordinates required; no geocoder, global weather or background alerting.
- OpenAlex: fixed scholarly-work metadata search endpoint. The adapter intentionally requires OPENALEX_API_KEY on the server; no production credential was available or used in this run. Current docs may permit small anonymous usage; this application does not silently switch to anonymous access. API key activation/quota is verified only on use.

Credentials are backend-only. PUBLIC_API_USER_AGENT identifies this application (optionally your own contact URL). API tools are read-only, strict-schema, bounded responses with source URLs/retrieval timestamps, cancellation/deadlines and no redirects or arbitrary URL input. A capability marked available indicates code/configuration, not a live upstream health check. Provider failures are surfaced, never replaced with fabricated data.

Sources: https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation ; https://www.weather.gov/documentation/services-web-api ; https://developers.openalex.org/guides/authentication .

## Remaining dependency groups

Browser automation remains intentionally excluded. General web search, image/video/audio generation, transcription, arbitrary code execution, scheduler/live workers, user-authorized email/Slack/calendar/Airtable/Sheets/ads/warehouse connectors, customer-response hosting and certain API adapters are not implemented. Any outbound communication or advertising launch additionally needs explicit authorization and anti-spam safeguards. Listing metadata does not grant that authority.

## Per-item ledger

“Workflow” means an independently written recipe backed by available model/local tools; “Partial” explicitly omits parts of the original package; “Configured API” additionally needs the adapter/service prerequisites. “Source only” is not executable here.

| Kind | Entry | Replica coverage | Implementation tools or missing source dependencies |
|---|---|---|---|
| agent | [Prospector](https://hyperagent.com/marketplace/a/cca01M5CJP51P_X1PRQP81YVQBJVMX) | Source only | Web Search, Google Places |
| agent | [Sitesmith](https://hyperagent.com/marketplace/a/cca01M5CJQ7NP_HA3FJAMPXE789A73) | Source only | Web Search, Webpages |
| agent | [Opener](https://hyperagent.com/marketplace/a/cca01M5CJQT8A_QJPM3AJ84CM931MB) | Source only | Documents |
| agent | [Marisol](https://hyperagent.com/marketplace/a/cca01M3ME7X3F_NFMPVR6QZDMVFSN7) | Source only | Email, Scheduler |
| agent | [Theo](https://hyperagent.com/marketplace/a/cca01M3MEBNXR_N8DTEYN3NJQ9YNWT) | Source only | Images, Email, Webpages |
| agent | [Priya](https://hyperagent.com/marketplace/a/cca01M3MEDMZ5_06PSGNJZJG29MY5F) | Source only | Web Search, Email, Scheduler |
| agent | [Yuki](https://hyperagent.com/marketplace/a/cca01M3MEDWS8_PYVSSQV9SB9ZE81J) | Source only | Meta Ads, Images, Web Search |
| agent | [Bali Event Concierge (Lead Qualification)](https://hyperagent.com/marketplace/a/cca01M00X3F2G_ZBGY79RTGGC8K9GB) | Source only | Web Search, Email |
| agent | [Funnel](https://hyperagent.com/marketplace/a/cca01KYXN50ND_03507PD81PKRWZXM) | Source only | Meta Ads, Images, Scheduler |
| agent | [Redline: Sales Coach](https://hyperagent.com/marketplace/a/cca01KYXMSYZG_BAZDV0JKTZ7WYZH1) | Workflow | Documents |
| agent | [Inbound](https://hyperagent.com/marketplace/a/cca01KY2P548K_MD7GCZGRBCW6DPEK) | Source only | Email, Calendar, Web Search |
| agent | [Automated Network Watering](https://hyperagent.com/marketplace/a/cca01KXSKA7NH_7FNNEJKT1FAWMCJR) | Source only | Airtable, Email, Scheduler |
| agent | [Momentum: Growth Marketing](https://hyperagent.com/marketplace/a/cca01KX3XM2A9_HJCJZXBEFDEXFDBQ) | Source only | Web Search, Images |
| skill | [Personalized Outbound Assets](https://hyperagent.com/marketplace/s/ccs01M5JFCGW4_AH40WENAF7JFGS8V) | Source only | Web Search, Images |
| skill | [Before and After Transformation](https://hyperagent.com/marketplace/s/ccs01M28E4GGA_88HW1GQ51J1MMNQN) | Source only | Images, Webpages |
| skill | [Lead Response](https://hyperagent.com/marketplace/s/ccs01M28E9RP4_4J9G68V59WSWGN1A) | Source only | Email |
| skill | [Meta Campaign Launch](https://hyperagent.com/marketplace/s/ccs01M28EKB6X_A6XSDSQ5SVJQS6V3) | Source only | Meta Ads, Images, Web Search |
| skill | [Visual Quotes](https://hyperagent.com/marketplace/s/ccs01M28EMKC9_D32B0YQ10HW9K49G) | Source only | Webpages, Customer Responses |
| skill | [Lead Revival](https://hyperagent.com/marketplace/s/ccs01M28ENH3F_TPG4TAZ401G7ZMVY) | Source only | Email, Scheduler |
| skill | [Daily Lead Warm-Up — Score, Rank & Send](https://hyperagent.com/marketplace/s/ccs01M00X72R8_X9CN8C4B2F6JH93R) | Source only | Email, Scheduler |
| skill | [Small Biz Website Builder](https://hyperagent.com/marketplace/s/ccs01KWD5P8B9_R6V4J0H5DEP88A2N) | Source only | Web Search, Google Places, Browser, Webpages |
| skill | [NYC Subway Campaign](https://hyperagent.com/marketplace/s/ccs01KVDKQYEG_24WX5741812RBTGG) | Source only | Images, Webpages |
| skill | [Landscaping Design and Quote](https://hyperagent.com/marketplace/s/ccs01KVDKCD84_WM4B6FDNHHR88S6B) | Source only | Images, Maps, Webpages |
| agent | [Script Lab](https://hyperagent.com/marketplace/a/cca01KXVV12TE_RYH7F0YCA1R20A2N) | Source only | Web Search, Documents |
| skill | [Frame Scout](https://hyperagent.com/marketplace/s/ccs01M4993R34_KBD7MJ1AHXBZA9C7) | Source only | Web Search, Maps |
| skill | [PG-Style Pitch Review](https://hyperagent.com/marketplace/s/ccs01KYMX0HJV_ZZ83EWK5KX2P2NJC) | Workflow | Documents |
| skill | [wiki-builder](https://hyperagent.com/marketplace/s/ccs01KXE6517H_XZ5CR1ZSYW20X9WQ) | Partial | Thread Search, Documents, Webpages, Tables |
| skill | [Roast My Idea](https://hyperagent.com/marketplace/s/ccs01KWCXR3W4_XRNS6AAXVZBT0617) | Workflow | Documents |
| skill | [Landing Page Teardown](https://hyperagent.com/marketplace/s/ccs01KVX6CENX_KF5WZ6FV56Z2BAX9) | Source only | Browser, Images, Webpages |
| skill | [OpenAlex API](https://hyperagent.com/marketplace/s/ccs01KVDTRA0W_R6FWEKF5Q01K9VP7) | Configured API — key needed | OpenAlex, Tables, Documents |
| skill | [World Bank Indicators API](https://hyperagent.com/marketplace/s/ccs01KVDTYNVE_FHMBHKQ2CFP97ZVH) | Configured API — upstream verification applies | World Bank, Tables, Documents |
| skill | [SEC EDGAR API](https://hyperagent.com/marketplace/s/ccs01KVDV179B_B42RH02QKH5E5303) | Source only | SEC EDGAR |
| agent | [Callum](https://hyperagent.com/marketplace/a/cca01M3MEAYVB_CZVPH8SEEW8VP416) | Source only | Web Search, Email |
| agent | [Job Hunt Copilot](https://hyperagent.com/marketplace/a/cca01KWYVSMWK_M740XZMR2ZV26WM1) | Source only | Web Search, Email |
| agent | [Sizzle](https://hyperagent.com/marketplace/a/cca01M3X1VZHG_MZ85XF4767CBC3VY) | Source only | Browser, Code Execution, Video |
| skill | [Loopy API (Loop Library Skill)](https://hyperagent.com/marketplace/s/ccs01KYTQ4NDJ_R2BX7VN35Y16CR97) | Source only | Loopy, Code Execution |
| skill | [Agent self-explainer](https://hyperagent.com/marketplace/s/ccs01KYRG5K2F_SMVVEYTDM5279DT5) | Source only | Webpages, Video |
| skill | [Easing Curves](https://hyperagent.com/marketplace/s/ccs01KXRGSZP3_H0M2QXN44FE6749H) | Partial | Documents, Webpages |
| skill | [Swiss Grid Design](https://hyperagent.com/marketplace/s/ccs01KVDKJSHG_WY8R9N89QBT5B7ZD) | Partial | Webpages |
| agent | [Taste Test](https://hyperagent.com/marketplace/a/cca01KXH6E0YP_PVVB158ZT7QBV45X) | Source only | Vision |
| agent | [Nora: Video Producer](https://hyperagent.com/marketplace/a/cca01KVDHD4PN_EXY2FESTJ6RGTNNJ) | Source only | Images, Video, Audio, Code Execution |
| agent | [Folio: Product Merchandising](https://hyperagent.com/marketplace/a/cca01KVDH3YD0_QJMZP9XMV72DQ6TH) | Source only | Images, Webpages |
| skill | [Picture-to-Portfolio](https://hyperagent.com/marketplace/s/ccs01M28EAT2E_CFKK454858PGDK5X) | Source only | Vision, Images |
| skill | [Instagram Insights -> Google Sheets](https://hyperagent.com/marketplace/s/ccs01KYNC769N_HSAZNEVNY77MREJZ) | Source only | Instagram, Google Sheets |
| skill | [Design Shuffle](https://hyperagent.com/marketplace/s/ccs01KXKBZ32S_Q8RP2Y40Y4MR7FTW) | Source only | Web Search, Images, Webpages |
| skill | [B-Roll Generator](https://hyperagent.com/marketplace/s/ccs01KWW9863B_K2WF34HK4MHCBT5N) | Source only | Video, Audio, Code Execution |
| skill | [Vignelli Canon Design System](https://hyperagent.com/marketplace/s/ccs01KVDKYYTD_GVRHHKFWWB5N9ZSW) | Partial | Documents, Webpages |
| skill | [Veo + Hyperframes Videos](https://hyperagent.com/marketplace/s/ccs01KVDKXRCM_GBWQXD5XDXGPRB9A) | Source only | Video, Images, Code Execution |
| skill | [NYT Data Viz](https://hyperagent.com/marketplace/s/ccs01KVDKVFQH_V2C26Q7XJQP49P9X) | Partial | Tables, Webpages |
| skill | [Claymation Podcast Clips](https://hyperagent.com/marketplace/s/ccs01KVDKBEGW_DZ20GZN2YYY3W92J) | Source only | Video, Audio, Code Execution |
| skill | [Claymation Explainer](https://hyperagent.com/marketplace/s/ccs01KVDK9Y6H_2T0WDXCBN1VCYED6) | Source only | Video, Images, Audio |
| skill | [Morning Briefing Movie Trailer](https://hyperagent.com/marketplace/s/ccs01KVDK85FW_XJSBFK0ZC77AWC13) | Source only | Calendar, Email, Video |
| skill | [Brand Book Generator](https://hyperagent.com/marketplace/s/ccs01KVDK6KWA_GHNT3CD64AM3YM2W) | Partial | Documents, Webpages |
| agent | [Bottleneck Audit](https://hyperagent.com/marketplace/a/cca01M5CJPSH6_63JT7XQGDRKTZRQ3) | Workflow | Documents |
| agent | [Dmitri](https://hyperagent.com/marketplace/a/cca01M3MF8DCV_Q0VJ45E8R41DEDYP) | Source only | Calendar, Scheduler, Maps |
| agent | [AdPilot](https://hyperagent.com/marketplace/a/cca01KXP1P1EN_VCVAD2CXGRK2WHZH) | Source only | Meta Ads, Scheduler |
| agent | [Vera: Data Analyst](https://hyperagent.com/marketplace/a/cca01KVDGZC1E_1KA0AYATHMBFBBEZ) | Source only | Warehouse, Tables |
| skill | [US National Weather Service API](https://hyperagent.com/marketplace/s/ccs01KVDT0G2W_NTH1SY1DTE25C7DG) | Configured API — upstream verification applies | Weather, Documents |
| agent | [French Translator](https://hyperagent.com/marketplace/a/cca01KYJC2CEH_Y41EW8MH88HZ2SJD) | Source only | Slack |
| skill | [Daily Focus](https://hyperagent.com/marketplace/s/ccs01KWWB5PT3_X6B42D9DTHZB2ZFD) | Source only | Calendar, Email |
| skill | [Airtable Kanban Work Tracker](https://hyperagent.com/marketplace/s/ccs01KVDJA2SF_B9G0PXF4NPHJNEBK) | Source only | Airtable |

The UI displays each implementation's exact limitations. Requirements inferred from source-listing text are labelled as inferred, not official package manifests.


## Subsequent account-integration increment

Thirteen server-owned account API adapters and 31 bounded operations are now supplied; see INTEGRATIONS.md. This expands API availability after configuring credentials, but it does not automatically implement the source-only marketplace recipes, their unattended workers, media pipelines or full OAuth onboarding. The ledger above describes recipe coverage, not the later adapter inventory. Gmail creates drafts but does not send; generic Email dependencies remain unsatisfied where actual outbound sending is required.
