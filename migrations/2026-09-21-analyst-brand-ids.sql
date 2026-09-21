-- Puts a real brand id on the analyst's open proposals.
--
-- The summary names brands the way a person does, so the model answered
-- "Gede Studio" on one day and "GEDE" on another, and both were stored
-- as written. Neither matches a row in `brands`, so the email lost its
-- label and the fingerprint moved with the spelling, which is a second
-- way for the same judgement to arrive twice.
--
-- The code maps it back now. These are the rows that were already open
-- when it started doing so, with their fingerprints recomputed for the
-- corrected brand. Decided and expired rows are left as they are: they
-- are history, and rewriting history to look tidier is how a record
-- stops being one.
--
--   npx wrangler d1 execute meta-ads-agent --remote --     -c wrangler.local.jsonc --file migrations/2026-09-21-analyst-brand-ids.sql

update proposals set brand_id = 'gede', fingerprint = '6bd9939c86d8c250801225942ef68a9676da46d10395892cfbacefe6ae6428dd' where code = 'ADS-0044';  -- era Gede Studio
update proposals set brand_id = 'gede', fingerprint = 'af07fe42bac97bb266e2448955116dc0a93151888dbc23a07a4bef88c0e98218' where code = 'ADS-0053';  -- era Gede Studio
update proposals set brand_id = 'gede', fingerprint = 'c308f37467514d79e606ea1bbf94bdb59850aafe3ff426996fe76aea501bd047' where code = 'ADS-0109';  -- era GEDE
update proposals set brand_id = 'gede', fingerprint = '5e422996b2133cbca6b613262467d7f4205e666de0396b4376c7e3f4c73ae0d8' where code = 'ADS-0110';  -- era GEDE
update proposals set brand_id = 'gede', fingerprint = '430d9148c672d7bc5d694263555d269f4e3ebe2b473869a3c5d49e2e61ebfff0' where code = 'ADS-0111';  -- era GEDE
