# Poster First Lazy Video

## Contract

The poster is the complete initial hero and the LCP candidate. Video is attached
later as progressive enhancement. The page must remain beautiful and complete if
the video never downloads, cannot decode or is disabled by user preference.

Poster and video must share:

- the same camera position and focal length;
- the same aspect ratio, crop and `object-position`;
- the same lighting and geometry;
- the same neutral start and end pose;
- enough visual similarity that the fade is invisible.

The loop needs more than a similar pose. Match the last encoded frame to the
first in camera, exposure, color, moving texture position and motion velocity.
Water, leaves, fabric and birds can reveal a seam even when the human pose is
identical. Build the end-to-start blend offline, remove the audio track and
verify the seam after the final delivery encode rather than only in the source
master.

Never place the headline, navigation, buttons or essential information inside the
media. Keep them as semantic HTML above it.

## Media choreography

Locked camera is the default. Avoid zooms, pans, geometry warping and lighting
jumps unless the concept explicitly requires them.

Use variation without obvious repetition:

- continuous: water, leaves, grass, distant fabric, soft light;
- occasional: bird enters or lands, person shifts weight, glances to the side;
- rare: person drinks, opens a book, walks a few steps or reacts to an event.

For a 60 to 90 second master loop, target two to four small events and no more
than one signature human gesture. The same main gesture should not repeat more
often than roughly once per minute.

If generation is more stable in short clips, create several 8 to 20 second
segments that all begin and end on the same neutral anchor. Concatenate and blend
them offline into one master before web delivery. Runtime switching between
several videos costs more memory, decoding and failure handling; use it only when
the variation cannot be produced as one stable master.

Prompt every generated segment with:

```text
Use the supplied image as an exact composition reference. Locked camera. Preserve
architecture, objects, identity, proportions, lighting and crop. Only the named
elements move. Begin and end in the same neutral anchor state. No camera motion,
no new objects, no text, no morphing, no cuts. Motion is subtle and physically
plausible.
```

Then name only the movement for that segment. Do not ask the model to improvise
the whole scene.

## Delivery targets

- Poster: AVIF or WebP, explicit dimensions, high priority, normally under 300 KB.
- Video: WebM first, MP4 fallback, muted, `playsInline`, 24 to 30 fps, `yuv420p`.
- Authoring master: visually lossless mezzanine with no web byte budget. Preserve
  it for future crops and encodes.
- Short 8 to 20 second delivery: WebM under 3 MB and MP4 under 7 MB when visual
  quality allows.
- A 60 to 90 second master needs separate desktop and mobile delivery encodes.
  Start near 6 to 12 MB WebM for desktop and 3 to 7 MB WebM for mobile, then tune
  against visible quality and measured transfer cost. MP4 fallbacks may be larger.
- `preload="none"`; the initial DOM has no `video.src` and no `<source src>`.
- Version media filenames when responses use long immutable caching.

Measure on the actual scene. Texture, grain, water and foliage compress
differently; do not destroy the image merely to hit an arbitrary byte number.

## React implementation

Use the existing project's conventions. This pattern demonstrates the timing
contract; adapt naming and types to the repository.

```jsx
import { useEffect, useRef, useState } from "react";

function usePosterFirstVideo({
  sectionRef,
  videoRef,
  userPausedRef,
  desktopWebm,
  desktopMp4,
  mobileWebm,
  mobileMp4,
}) {
  const [canPlay, setCanPlay] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    const video = videoRef.current;
    if (!section || !video) return undefined;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mobileViewport = window.matchMedia("(max-width: 767px)");
    const connection =
      navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    let pageLoaded = document.readyState === "complete";
    let nearHero = false;
    let heroVisible = false;
    let sourcesAttached = false;
    let disposed = false;
    let idleId;
    let timerId;

    const isAllowed = () => !reducedMotion.matches && connection?.saveData !== true;
    const shouldPlay = () =>
      sourcesAttached &&
      isAllowed() &&
      heroVisible &&
      !document.hidden &&
      !userPausedRef.current;

    const cancelScheduled = () => {
      if (idleId != null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleId);
      }
      window.clearTimeout(timerId);
      idleId = undefined;
      timerId = undefined;
    };

    const unloadMedia = (updateState = true) => {
      video.pause();
      video.removeAttribute("src");
      video.querySelectorAll("source[data-hero-source]").forEach((source) => source.remove());
      video.load();
      sourcesAttached = false;
      if (updateState) {
        setCanPlay(false);
        setHasPlayed(false);
        setPlaying(false);
      }
    };

    const syncPlayback = () => {
      if (!shouldPlay()) {
        video.pause();
        return;
      }
      video.play().catch(() => setPlaying(false));
    };

    const selectedSources = () => {
      const useMobile = mobileViewport.matches && (mobileWebm || mobileMp4);
      return useMobile
        ? [
            { src: mobileWebm, type: "video/webm" },
            { src: mobileMp4, type: "video/mp4" },
          ]
        : [
            { src: desktopWebm, type: "video/webm" },
            { src: desktopMp4, type: "video/mp4" },
          ];
    };

    const attachSources = () => {
      if (disposed || sourcesAttached || !pageLoaded || !nearHero || !isAllowed()) return;
      for (const sourceSpec of selectedSources()) {
        if (!sourceSpec.src) continue;
        const source = document.createElement("source");
        source.src = sourceSpec.src;
        source.type = sourceSpec.type;
        source.dataset.heroSource = "true";
        video.appendChild(source);
      }
      sourcesAttached = video.querySelector("source[data-hero-source]") !== null;
      if (sourcesAttached) video.load();
    };

    const scheduleAttach = () => {
      if (disposed || sourcesAttached || !pageLoaded || !nearHero || !isAllowed()) return;
      cancelScheduled();
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(attachSources, { timeout: 2200 });
      } else {
        timerId = window.setTimeout(attachSources, 900);
      }
    };

    const onPreferenceChange = () => {
      if (!isAllowed()) {
        cancelScheduled();
        unloadMedia();
        return;
      }
      scheduleAttach();
      syncPlayback();
    };
    const onVariantChange = () => {
      if (!mobileWebm && !mobileMp4) return;
      cancelScheduled();
      unloadMedia();
      scheduleAttach();
    };
    const onLoad = () => {
      pageLoaded = true;
      scheduleAttach();
    };
    const onCanPlay = () => {
      setCanPlay(true);
      syncPlayback();
    };
    const onPlaying = () => {
      setHasPlayed(true);
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onError = () => unloadMedia();
    const onVisibilityChange = () => syncPlayback();

    if (!pageLoaded) window.addEventListener("load", onLoad, { once: true });
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("error", onError);
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.addEventListener?.("change", onPreferenceChange);
    connection?.addEventListener?.("change", onPreferenceChange);
    mobileViewport.addEventListener?.("change", onVariantChange);

    const preloadObserver = new IntersectionObserver(
      ([entry]) => {
        nearHero = entry.isIntersecting;
        if (nearHero) scheduleAttach();
        else if (!sourcesAttached) cancelScheduled();
      },
      { rootMargin: "200px 0px", threshold: 0 },
    );
    const playbackObserver = new IntersectionObserver(
      ([entry]) => {
        heroVisible = entry.isIntersecting;
        syncPlayback();
      },
      { threshold: 0.05 },
    );
    preloadObserver.observe(section);
    playbackObserver.observe(section);

    return () => {
      disposed = true;
      cancelScheduled();
      preloadObserver.disconnect();
      playbackObserver.disconnect();
      window.removeEventListener("load", onLoad);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("error", onError);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotion.removeEventListener?.("change", onPreferenceChange);
      connection?.removeEventListener?.("change", onPreferenceChange);
      mobileViewport.removeEventListener?.("change", onVariantChange);
      unloadMedia(false);
    };
  }, [
    sectionRef,
    videoRef,
    userPausedRef,
    desktopWebm,
    desktopMp4,
    mobileWebm,
    mobileMp4,
  ]);

  return { canPlay, hasPlayed, playing };
}

export function CinematicHero({
  poster,
  desktopVideo,
  mobileVideo = {},
  pauseStorageKey = "hero-motion-paused",
  children,
}) {
  const sectionRef = useRef(null);
  const videoRef = useRef(null);
  const [paused, setPaused] = useState(
    () => typeof window !== "undefined" && sessionStorage.getItem(pauseStorageKey) === "1",
  );
  const userPausedRef = useRef(paused);
  const { canPlay, hasPlayed, playing } = usePosterFirstVideo({
    sectionRef,
    videoRef,
    userPausedRef,
    desktopWebm: desktopVideo.webm,
    desktopMp4: desktopVideo.mp4,
    mobileWebm: mobileVideo.webm,
    mobileMp4: mobileVideo.mp4,
  });

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      userPausedRef.current = false;
      sessionStorage.removeItem(pauseStorageKey);
      video.play().then(() => setPaused(false)).catch(() => {});
    } else {
      userPausedRef.current = true;
      sessionStorage.setItem(pauseStorageKey, "1");
      video.pause();
      setPaused(true);
    }
  };

  return (
    <section
      className="hero"
      ref={sectionRef}
      style={{ "--hero-position": poster.objectPosition || "center" }}
    >
      <div className="heroMedia" aria-hidden="true">
        <img
          className="heroPoster"
          src={poster.src}
          srcSet={poster.srcSet}
          sizes={poster.sizes || "100vw"}
          alt=""
          width={poster.width}
          height={poster.height}
          fetchPriority="high"
          decoding="async"
        />
        <video
          ref={videoRef}
          className={`heroVideo ${hasPlayed ? "isReady" : ""}`}
          muted
          loop
          playsInline
          preload="none"
          tabIndex="-1"
        />
      </div>
      <div className="heroContent">{children}</div>
      {canPlay && (
        <button
          className="heroMotionControl"
          type="button"
          aria-pressed={paused}
          onClick={togglePlayback}
        >
          {paused || !playing ? "Play background motion" : "Pause background motion"}
        </button>
      )}
    </section>
  );
}
```

```css
.hero {
  position: relative;
  isolation: isolate;
  overflow: hidden;
}

.heroMedia,
.heroPoster,
.heroVideo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.heroPoster,
.heroVideo {
  object-fit: cover;
  object-position: var(--hero-position, center);
}

.heroVideo {
  opacity: 0;
  transition: opacity 900ms ease;
}

.heroVideo.isReady {
  opacity: 1;
}

.heroContent,
.heroMotionControl {
  position: relative;
  z-index: 2;
}

@media (prefers-reduced-motion: reduce) {
  .heroVideo,
  .heroMotionControl {
    display: none;
  }
}
```

For vanilla JavaScript, keep the same state machine: observe the hero, wait for
`load`, schedule source creation in idle time, then call `video.load()`. Use
`canplay` to expose the control and `playing` to fade the video in. Route every
playback entry through one condition that checks actual viewport visibility,
document visibility, current motion and data preferences, loaded sources and the
user pause preference. Do not place static source nodes in the HTML. Persist a
manual pause for at least the current session, localize the control labels and
pass real poster dimensions, responsive poster sources and separate mobile media
when the crop or byte budget needs them. The data saver signal is enforceable only
when the browser exposes the Network Information API; reduced motion remains the
portable baseline.

## Seam and playback verification

- Compare the first and last frame; target SSIM of at least 0.96 when measurable.
- Keep average luminance within roughly 3 percent at the seam.
- Watch at least three complete loops at desktop and mobile crops after the
  final encode, with no audio track present.
- The seam must be quieter than the strongest ordinary adjacent-frame change.
- Confirm the poster to first video frame transition is not visible.
- Confirm zero video bytes transfer before the lazy trigger.
- Confirm reduced motion and data saver produce no video request.
- Confirm decode failure leaves the poster and content intact.

Do not hide a poor seam with an aggressive crossfade. Repair the anchor frames or
blend compatible neutral frames offline.
