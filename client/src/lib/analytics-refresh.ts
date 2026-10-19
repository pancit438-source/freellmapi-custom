export const ANALYTICS_REFRESH_KEY = 'analytics.refreshMs'
export const ANALYTICS_REFRESH_INTERVALS: readonly number[] = [0, 5_000, 15_000, 30_000]

export function storedAnalyticsRefreshMs(): number {
  try {
    const stored = localStorage.getItem(ANALYTICS_REFRESH_KEY)
    if (stored !== null && stored.trim() !== '') {
      const interval = Number(stored)
      if (ANALYTICS_REFRESH_INTERVALS.includes(interval)) return interval
    }
  } catch { /* Storage can be unavailable in a private browser. */ }
  return 5_000
}

interface PollingOptions {
  refetchInterval: number | false
  refetchIntervalInBackground: false
  refetchOnWindowFocus: 'always' | false
  refetchOnReconnect: 'always' | false
}

export function analyticsPollingOptions(interval: number): PollingOptions {
  return {
    refetchInterval: interval > 0 ? interval : false,
    refetchIntervalInBackground: false,
    // Refresh immediately after returning, including within the global 30s
    // stale window. Paused views should not receive a focus/reconnect refresh.
    refetchOnWindowFocus: interval > 0 ? 'always' : false,
    refetchOnReconnect: interval > 0 ? 'always' : false,
  }
}
