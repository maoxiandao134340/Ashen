/**
 * Vercel Web Analytics utility for serverless functions
 * 
 * This module provides analytics tracking capabilities for the Ashen Memory MCP Server.
 * While this is primarily a backend API, we can still track page views when the health
 * check endpoint is accessed via browser.
 */

import { track } from '@vercel/analytics/server';

/**
 * Track a custom event to Vercel Analytics
 * 
 * @param eventName - Name of the event to track
 * @param data - Optional event data
 */
export async function trackEvent(eventName: string, data?: Record<string, any>) {
  try {
    await track(eventName, data);
  } catch (error) {
    // Silently fail to not disrupt API functionality
    console.error('Analytics tracking error:', error);
  }
}

/**
 * Get the analytics script injection code for HTML responses
 * This allows the browser to track page views when accessing the API health check
 */
export function getAnalyticsScriptTag(): string {
  return `
    <script>
      window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
  `;
}

/**
 * Inject analytics into an HTML response
 * 
 * @param html - HTML content to inject analytics into
 * @returns HTML with analytics script injected before </head> or </body>
 */
export function injectAnalytics(html: string): string {
  const scriptTag = getAnalyticsScriptTag();
  
  // Try to inject before closing head tag
  if (html.includes('</head>')) {
    return html.replace('</head>', `${scriptTag}</head>`);
  }
  
  // Fallback: inject before closing body tag
  if (html.includes('</body>')) {
    return html.replace('</body>', `${scriptTag}</body>`);
  }
  
  // If no head or body tags, just append
  return html + scriptTag;
}
