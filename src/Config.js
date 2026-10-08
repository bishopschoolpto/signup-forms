/**
 * Runtime configuration, read from Script Properties
 * (Apps Script editor → Project Settings → Script Properties).
 *
 *   EVENTS_FOLDER_ID  Drive folder of open events: a spreadsheet directly in
 *                     it (not in a subfolder) takes sign-ups.
 *   PAST_EVENTS_FOLDER_ID  Drive folder of past events: a spreadsheet directly
 *                     in it is still shown, but takes no new sign-ups.
 *   ORG_NAME          Display name used on pages and as the email sender name.
 *   MAIL_REDIRECT_TO  If set, EVERY email goes to this address instead of the
 *                     volunteer or organizer. Use this on test deployments.
 *   TINYURL_API_TOKEN API token from a TinyURL account, for making short
 *                     links with TinyURL's current API (see ShortLink.js).
 *   ADMIN_EMAIL       Who organizers contact for access or help (used in the
 *                     spreadsheets' Start here tab).
 *   SITE_URL          The static site's address, used for short links made
 *                     from anywhere but the Apps Script page itself.
 *   EDGE_URL          The Cloudflare Worker (edge/) that serves event data to
 *                     the static site, e.g. https://signups-edge.<account>.workers.dev
 *   EDGE_SECRET       The Worker's PUBLISH_SECRET. Without both EDGE_ settings
 *                     nothing is published (see Edge.js).
 */
var DEFAULT_ORG_NAME = 'Bishop School PTO';
var DEFAULT_EVENTS_FOLDER_ID = '1yX2nxEPACkQkJLyeWYbRjd-8x0MmK55c';
var DEFAULT_PAST_EVENTS_FOLDER_ID = '1jdmAElexrsedV46-6INgjFUMQF7ycAP9';
var DEFAULT_SITE_URL = 'https://signups.bishopschoolpto.com/';
var DEFAULT_ADMIN_EMAIL = 'admin@bishopschoolpto.com';

function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    eventsFolderId: props.getProperty('EVENTS_FOLDER_ID') || DEFAULT_EVENTS_FOLDER_ID,
    pastEventsFolderId: props.getProperty('PAST_EVENTS_FOLDER_ID') || DEFAULT_PAST_EVENTS_FOLDER_ID,
    templateId: props.getProperty('TEMPLATE_ID') || '',
    orgName: props.getProperty('ORG_NAME') || DEFAULT_ORG_NAME,
    mailRedirectTo: props.getProperty('MAIL_REDIRECT_TO') || '',
    siteUrl: props.getProperty('SITE_URL') || DEFAULT_SITE_URL,
    adminEmail: props.getProperty('ADMIN_EMAIL') || DEFAULT_ADMIN_EMAIL,
    tinyUrlApiToken: props.getProperty('TINYURL_API_TOKEN') || '',
    edgeUrl: props.getProperty('EDGE_URL') || '',
    edgeSecret: props.getProperty('EDGE_SECRET') || '',
    timeZone: Session.getScriptTimeZone(),
  };
}

/**
 * The page links should point to: the Apps Script web app if that's the page
 * the request came from, and the static site (SITE_URL) otherwise, so callers
 * can't make links point anywhere else.
 */
function pageBaseUrl_(requested) {
  var scriptUrl = ScriptApp.getService().getUrl();
  return requested && requested === scriptUrl ? scriptUrl : getConfig_().siteUrl;
}
