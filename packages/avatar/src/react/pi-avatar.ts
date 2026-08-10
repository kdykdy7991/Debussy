/**
 * React adapter for `<pi-avatar>` (task B5).
 *
 * A thin forward-ref wrapper: serializable props map to element attributes,
 * event callbacks map to the six standard events, and the ref exposes the real
 * `PiAvatarElement` so the host can call the imperative `AvatarController`
 * methods. No core/audio/renderer logic is duplicated here.
 *
 * Object characters are NOT supported: Phase 1 declarative `character` accepts
 * only the manifest URL string, matching the web-component attribute surface.
 * Object manifests use the embed SDK / imperative element API instead.
 */

import * as React from "react";
import type {
  AvatarDisplayMode,
  AvatarEventMap,
  AvatarPosition,
  AvatarState,
} from "../core/index.js";
import type { PiAvatarElement } from "../web-component/index.js";
// Loading this entry registers `<pi-avatar>` (guarded) so hosts that only
// import the React entry get a defined element.
import { registerPiAvatarElement } from "../web-component/index.js";
registerPiAvatarElement();

export type { PiAvatarElement };

/** Props for the React `PiAvatar` component. Mirrors the element attribute surface. */
export interface PiAvatarProps {
  /** Manifest URL. Changing this re-initializes the avatar (B2 semantics). */
  character: string;
  /** Initial state. */
  state?: AvatarState;
  /** Display mode: "inline" (default) or "floating". */
  mode?: AvatarDisplayMode;
  /** Floating position: "bottom-right" (default) or "bottom-left". */
  position?: AvatarPosition;
  /** Width (number = px, string = CSS length). */
  width?: number | string;
  /** Height (number = px, string = CSS length). */
  height?: number | string;
  /** Stage background CSS value. */
  background?: string;
  /** Autoplay speech on load. `false` is expressed as the `"false"` attribute. */
  autoplay?: boolean;

  /** HTML id attribute. */
  id?: string;
  /** HTML class attribute. */
  className?: string;
  /** Inline CSS styles applied to the element. */
  style?: React.CSSProperties;
  /** ARIA label for accessibility. */
  "aria-label"?: string;

  onAvatarReady?: (detail: AvatarEventMap["avatar-ready"]["detail"]) => void;
  onAvatarStateChange?: (detail: AvatarEventMap["avatar-state-change"]["detail"]) => void;
  onAvatarSpeechStart?: (detail: AvatarEventMap["avatar-speech-start"]["detail"]) => void;
  onAvatarSpeechEnd?: (detail: AvatarEventMap["avatar-speech-end"]["detail"]) => void;
  onAvatarError?: (detail: AvatarEventMap["avatar-error"]["detail"]) => void;
  onAvatarInterrupted?: (detail: AvatarEventMap["avatar-interrupted"]["detail"]) => void;
}

/** Maps each supported callback prop to the native event name it drives. */
const EVENT_MAP = {
  onAvatarReady: "avatar-ready",
  onAvatarStateChange: "avatar-state-change",
  onAvatarSpeechStart: "avatar-speech-start",
  onAvatarSpeechEnd: "avatar-speech-end",
  onAvatarError: "avatar-error",
  onAvatarInterrupted: "avatar-interrupted",
} as const;

type EventProp = keyof typeof EVENT_MAP;

/**
 * Thin React wrapper around `<pi-avatar>`.
 *
 * One set of native listeners is registered for the element's lifetime; the
 * handler invoked at dispatch time is always the latest prop version, so
 * callback updates never re-register, never double-dispatch, and never recreate
 * the element. The ref forwards to the underlying `PiAvatarElement`.
 */
export const PiAvatar = React.forwardRef<PiAvatarElement, PiAvatarProps>(
  function PiAvatar(props, ref) {
    const elementRef = React.useRef<PiAvatarElement | null>(null);
    const handlersRef =
      React.useRef<Partial<Record<EventProp, (detail: unknown) => void>>>({});

    // Cache the latest callback versions so listener registration stays stable.
    const handlers: Partial<Record<EventProp, (detail: unknown) => void>> = {};
    for (const prop of Object.keys(EVENT_MAP) as EventProp[]) {
      const callback = props[prop];
      if (callback !== undefined) {
        handlers[prop] = callback as (detail: unknown) => void;
      }
    }
    handlersRef.current = handlers;

    // Register one set of native listeners for the element's lifetime.
    React.useEffect(() => {
      const element = elementRef.current;
      if (!element) {
        return;
      }
      const bound: Array<[string, (event: Event) => void]> = [];
      for (const [prop, name] of Object.entries(EVENT_MAP) as Array<[EventProp, string]>) {
        const handler = (event: Event): void => {
          handlersRef.current[prop]?.((event as CustomEvent).detail);
        };
        element.addEventListener(name, handler);
        bound.push([name, handler]);
      }
      return () => {
        for (const [name, handler] of bound) {
          element.removeEventListener(name, handler);
        }
      };
    }, []);

    const setRef = (element: PiAvatarElement | null): void => {
      elementRef.current = element;
      if (typeof ref === "function") {
        ref(element);
      } else if (ref) {
        ref.current = element;
      }
    };

    // Apply avatar attributes imperatively instead of passing them as React
    // element props. React tries to reflect unknown props onto the custom
    // element as *properties*, and `state` is a getter-only property on
    // `PiAvatarElement` — React would throw. Setting attributes in an effect
    // also gives us precise control over attribute removal when a prop drops.
    React.useLayoutEffect(() => {
      const element = elementRef.current;
      if (!element) {
        return;
      }
      const set = (name: string, value?: unknown): void => {
        if (value === undefined || value === null) {
          element.removeAttribute(name);
        } else {
          element.setAttribute(name, String(value));
        }
      };

      // Avoid reflecting an unchanged character URL: Custom Elements invoke
      // attributeChangedCallback even when setAttribute repeats the same value,
      // and character changes intentionally rebuild the Controller.
      if (props.character !== element.getAttribute("character")) {
        set("character", props.character);
      }
      set("state", props.state);
      set("mode", props.mode);
      set("position", props.position);
      set("background", props.background);
      set("id", props.id);
      set("class", props.className);
      set("aria-label", props["aria-label"]);
      set(
        "width",
        props.width === undefined ? undefined : typeof props.width === "number" ? `${props.width}px` : props.width,
      );
      set(
        "height",
        props.height === undefined ? undefined : typeof props.height === "number" ? `${props.height}px` : props.height,
      );
      // false autoplay must be expressed as the recognizable "false" attribute.
      set("autoplay", props.autoplay === undefined ? undefined : props.autoplay ? "" : "false");
    }, [
      props.character,
      props.state,
      props.mode,
      props.position,
      props.background,
      props.id,
      props.className,
      props["aria-label"],
      props.width,
      props.height,
      props.autoplay,
    ]);

    return React.createElement(
      "pi-avatar",
      {
        ref: setRef,
        style: props.style,
      } as React.HTMLAttributes<HTMLElement>,
    );
  },
);

PiAvatar.displayName = "PiAvatar";

export default PiAvatar;