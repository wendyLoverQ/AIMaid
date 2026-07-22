import { Paragraph, PetBubbleSurface } from "../../components/ui";
import { useEffect, useRef, useState } from 'react';
export interface PetBubbleProps {
    text: string;
    visible: boolean;
}
export function PetBubble({ text, visible }: PetBubbleProps): React.JSX.Element | null {
    const [shown, setShown] = useState(visible && text.trim().length > 0);
    const held = useRef(false);
    const hideTimer = useRef<number | null>(null);
    const clearHideTimer = (): void => {
        if (hideTimer.current !== null)
            window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
    };
    const scheduleHide = (delayMs: number): void => {
        clearHideTimer();
        if (held.current)
            return;
        hideTimer.current = window.setTimeout(() => {
            hideTimer.current = null;
            setShown(false);
        }, delayMs);
    };
    useEffect(() => {
        clearHideTimer();
        if (!visible || text.trim().length === 0) {
            setShown(false);
            return;
        }
        setShown(true);
        scheduleHide(bubbleDisplayDurationMs(text));
        return clearHideTimer;
    }, [text, visible]);
    useEffect(() => {
        const updateHold = (isHeld: boolean): void => {
            held.current = isHeld;
            if (isHeld)
                clearHideTimer();
            else if (shown)
                scheduleHide(6000);
        };
        const onStorage = (event: StorageEvent): void => {
            if (event.key !== 'aimaid.bubble-hold' || event.newValue === null)
                return;
            try {
                const value = JSON.parse(event.newValue) as { held?: unknown };
                if (typeof value.held === 'boolean')
                    updateHold(value.held);
            }
            catch { /* ignore malformed cross-window state */ }
        };
        const onLocal = (event: Event): void => {
            const detail = (event as CustomEvent<{ held?: unknown }>).detail;
            if (typeof detail?.held === 'boolean')
                updateHold(detail.held);
        };
        window.addEventListener('storage', onStorage);
        window.addEventListener('aimaid:bubble-hold', onLocal);
        return () => {
            window.removeEventListener('storage', onStorage);
            window.removeEventListener('aimaid:bubble-hold', onLocal);
            clearHideTimer();
        };
    }, [shown]);
    if (!shown || !visible || text.trim().length === 0)
        return null;
    return (<PetBubbleSurface role="status" aria-live="polite">
      <Paragraph>{text}</Paragraph>
    </PetBubbleSurface>);
}

export function bubbleDisplayDurationMs(text: string): number {
    return Math.min(30000, 3500 + Array.from(text).length * 80);
}
