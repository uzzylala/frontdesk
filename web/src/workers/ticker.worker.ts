// A metronome and nothing else. Browsers throttle timers on the page's main
// thread once a tab has been in the background for a while (Chrome: down to
// one wake-up a minute), which is far slower than the 15s window the server
// gives a heartbeat. Timers inside a dedicated worker aren't subject to that,
// so the clock lives here and the page just reacts to each 'tick' message.
// Message delivery to a background page isn't throttled.

type Command = { type: 'start'; intervalMs: number } | { type: 'stop' }

let timer: ReturnType<typeof setInterval> | undefined

self.onmessage = (event: MessageEvent<Command>) => {
  clearInterval(timer)
  timer = undefined
  if (event.data.type === 'start') {
    timer = setInterval(() => self.postMessage('tick'), event.data.intervalMs)
  }
}
