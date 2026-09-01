import { esc } from './ui';

/**
 * Formatuje akcelerator lub przycisk myszy (np. 'CommandOrControl+Shift+V', 'Mouse4', 'Ctrl+Mouse5')
 * na czytelne kafelki HTML w stylu Fan Control.
 */
export function formatAcceleratorDisplay(accelerator?: string): string {
  if (!accelerator || !accelerator.trim()) {
    return `<span class="fc-hotkey-none">Brak skrótu (kliknij, aby nagrać klawisz lub mysz)</span>`;
  }

  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    return `<span class="fc-hotkey-none">Brak skrótu (kliknij, aby nagrać klawisz lub mysz)</span>`;
  }

  const badges = parts.map((part) => {
    let label = part;
    const lower = part.toLowerCase();

    if (part === 'CommandOrControl' || part === 'CmdOrCtrl' || part === 'Control' || part === 'Ctrl') {
      label = 'Ctrl';
    } else if (part === 'Shift') {
      label = 'Shift';
    } else if (part === 'Alt' || part === 'Option') {
      label = 'Alt';
    } else if (part === 'Super' || part === 'Meta' || part === 'Win' || part === 'Command') {
      label = 'Win';
    } else if (lower === 'mouse4' || lower === 'xbutton1') {
      label = '🖱️ Mysz 4 (Boczny Wstecz)';
    } else if (lower === 'mouse5' || lower === 'xbutton2') {
      label = '🖱️ Mysz 5 (Boczny Dalej)';
    } else if (lower === 'mouse3' || lower === 'mbutton') {
      label = '🖱️ Mysz 3 (Środkowy / Kółko)';
    } else if (lower === 'mouse2' || lower === 'rbutton') {
      label = '🖱️ Mysz 2 (Prawy)';
    } else if (lower === 'mouse1' || lower === 'lbutton') {
      label = '🖱️ Mysz 1 (Lewy)';
    } else if (part === 'Space' || lower === 'space') {
      label = 'Spacja';
    } else if (part === 'Return' || part === 'Enter' || lower === 'return') {
      label = 'Enter';
    } else if (part === 'Escape' || part === 'Esc' || lower === 'escape') {
      label = 'Esc';
    } else if (part === 'Tab') {
      label = 'Tab';
    } else if (part === 'Backspace') {
      label = 'Backspace';
    } else if (part === 'Delete') {
      label = 'Del';
    } else if (part === 'Insert') {
      label = 'Ins';
    } else if (part === 'Home') {
      label = 'Home';
    } else if (part === 'End') {
      label = 'End';
    } else if (part === 'PageUp') {
      label = 'PgUp';
    } else if (part === 'PageDown') {
      label = 'PgDn';
    } else if (part === 'Up') {
      label = '↑';
    } else if (part === 'Down') {
      label = '↓';
    } else if (part === 'Left') {
      label = '←';
    } else if (part === 'Right') {
      label = '→';
    } else if (part.startsWith('num')) {
      const sub = part.slice(3);
      if (sub === 'add') label = 'Num +';
      else if (sub === 'sub') label = 'Num -';
      else if (sub === 'mult') label = 'Num *';
      else if (sub === 'div') label = 'Num /';
      else if (sub === 'dec') label = 'Num .';
      else label = `Num ${sub}`;
    }

    return `<kbd class="fc-kbd">${esc(label)}</kbd>`;
  });

  return badges.join('<span class="fc-hotkey-plus">+</span>');
}

/**
 * Konwertuje zdarzenie klawiatury na format akceleratora.
 */
export function keyboardEventToAccelerator(e: KeyboardEvent): {
  accelerator: string | null;
  isModifierOnly: boolean;
  previewHtml: string;
} {
  const isCtrl = e.ctrlKey || e.key === 'Control';
  const isShift = e.shiftKey || e.key === 'Shift';
  const isAlt = e.altKey || e.key === 'Alt';
  const isMeta = e.metaKey || e.key === 'Meta';

  // Sam klawisz modyfikatora (użytkownik dopiero trzyma Ctrl/Alt/Shift...)
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    const mods: string[] = [];
    if (isCtrl) mods.push('<kbd class="fc-kbd">Ctrl</kbd>');
    if (isAlt) mods.push('<kbd class="fc-kbd">Alt</kbd>');
    if (isShift) mods.push('<kbd class="fc-kbd">Shift</kbd>');
    if (isMeta) mods.push('<kbd class="fc-kbd">Win</kbd>');

    const preview = mods.length > 0
      ? `${mods.join('<span class="fc-hotkey-plus">+</span>')}<span class="fc-hotkey-plus">+</span><span class="fc-hotkey-waiting">…</span>`
      : '<span class="fc-hotkey-waiting">Wciśnij klawisz lub przycisk myszy…</span>';

    return {
      accelerator: null,
      isModifierOnly: true,
      previewHtml: preview
    };
  }

  let key = '';
  const code = e.code;

  if (code.startsWith('Key')) {
    key = code.slice(3).toUpperCase();
  } else if (code.startsWith('Digit')) {
    key = code.slice(5);
  } else if (code.startsWith('Numpad')) {
    const numPart = code.slice(6);
    if (/^\d$/.test(numPart)) key = `num${numPart}`;
    else if (numPart === 'Add') key = 'numadd';
    else if (numPart === 'Subtract') key = 'numsub';
    else if (numPart === 'Multiply') key = 'nummult';
    else if (numPart === 'Divide') key = 'numdiv';
    else if (numPart === 'Decimal') key = 'numdec';
    else key = numPart;
  } else if (/^F\d{1,2}$/i.test(e.key)) {
    key = e.key.toUpperCase();
  } else if (e.key === ' ' || code === 'Space') {
    key = 'Space';
  } else if (e.key === 'Enter' || code === 'Enter' || code === 'NumpadEnter') {
    key = 'Return';
  } else if (e.key === 'Tab' || code === 'Tab') {
    key = 'Tab';
  } else if (e.key === 'Backspace' || code === 'Backspace') {
    key = 'Backspace';
  } else if (e.key === 'Delete' || code === 'Delete') {
    key = 'Delete';
  } else if (e.key === 'Insert' || code === 'Insert') {
    key = 'Insert';
  } else if (e.key === 'Home' || code === 'Home') {
    key = 'Home';
  } else if (e.key === 'End' || code === 'End') {
    key = 'End';
  } else if (e.key === 'PageUp' || code === 'PageUp') {
    key = 'PageUp';
  } else if (e.key === 'PageDown' || code === 'PageDown') {
    key = 'PageDown';
  } else if (e.key === 'ArrowUp' || code === 'ArrowUp') {
    key = 'Up';
  } else if (e.key === 'ArrowDown' || code === 'ArrowDown') {
    key = 'Down';
  } else if (e.key === 'ArrowLeft' || code === 'ArrowLeft') {
    key = 'Left';
  } else if (e.key === 'ArrowRight' || code === 'ArrowRight') {
    key = 'Right';
  } else if (e.key === 'Escape' || code === 'Escape') {
    key = 'Escape';
  } else if (e.key === '`' || e.key === '~' || code === 'Backquote') {
    key = '`';
  } else if (e.key === '-' || e.key === '_' || code === 'Minus') {
    key = '-';
  } else if (e.key === '=' || e.key === '+' || code === 'Equal') {
    key = 'Plus';
  } else if (e.key === '[' || e.key === '{' || code === 'BracketLeft') {
    key = '[';
  } else if (e.key === ']' || e.key === '}' || code === 'BracketRight') {
    key = ']';
  } else if (e.key === '\\' || e.key === '|' || code === 'Backslash') {
    key = '\\';
  } else if (e.key === ';' || e.key === ':' || code === 'Semicolon') {
    key = ';';
  } else if (e.key === "'" || e.key === '"' || code === 'Quote') {
    key = "'";
  } else if (e.key === ',' || e.key === '<' || code === 'Comma') {
    key = ',';
  } else if (e.key === '.' || e.key === '>' || code === 'Period') {
    key = '.';
  } else if (e.key === '/' || e.key === '?' || code === 'Slash') {
    key = '/';
  } else if (e.key.length === 1) {
    key = e.key.toUpperCase();
  }

  if (!key) {
    return { accelerator: null, isModifierOnly: false, previewHtml: '' };
  }

  const mods: string[] = [];
  if (isCtrl) mods.push('CommandOrControl');
  if (isAlt) mods.push('Alt');
  if (isShift) mods.push('Shift');
  if (isMeta) mods.push('Super');

  const accelerator = mods.length > 0 ? `${mods.join('+')}+${key}` : key;
  return {
    accelerator,
    isModifierOnly: false,
    previewHtml: formatAcceleratorDisplay(accelerator)
  };
}

/**
 * Konwertuje kliknięcie myszy na identyfikator przycisku (Mouse1-Mouse5 + modyfikatory).
 */
export function mouseEventToAccelerator(e: MouseEvent): string | null {
  let btnName = '';
  if (e.button === 0) btnName = 'Mouse1';
  else if (e.button === 1) btnName = 'Mouse3'; // Middle click
  else if (e.button === 2) btnName = 'Mouse2'; // Right click
  else if (e.button === 3) btnName = 'Mouse4'; // Back button
  else if (e.button === 4) btnName = 'Mouse5'; // Forward button
  else if (e.button >= 5) btnName = `Mouse${e.button + 1}`;

  if (!btnName) return null;

  const mods: string[] = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  return mods.length > 0 ? `${mods.join('+')}+${btnName}` : btnName;
}

export interface HotkeyRecorderOptions {
  buttonId: string;
  displayId?: string;
  clearButtonId?: string;
  getCurrentShortcut: () => string;
  onSave: (accelerator: string) => void;
  onClear: () => void;
  toast?: (msg: string) => void;
}

/**
 * Podpina interaktywne nagrywanie skrótu klawiszowego lub przycisku myszy.
 */
export function bindHotkeyRecorder(opts: HotkeyRecorderOptions): () => void {
  const btn = document.getElementById(opts.buttonId);
  const clearBtn = opts.clearButtonId ? document.getElementById(opts.clearButtonId) : null;
  if (!btn) return () => {};

  let isRecording = false;
  let recordStartTime = 0;
  const displayEl = opts.displayId ? document.getElementById(opts.displayId) : btn.querySelector('.fc-hotkey-display');

  const restoreDisplay = () => {
    isRecording = false;
    btn.classList.remove('recording');
    const current = opts.getCurrentShortcut();
    if (displayEl) {
      displayEl.innerHTML = formatAcceleratorDisplay(current);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!isRecording) return;
    e.preventDefault();
    e.stopPropagation();

    // Samodzielny Esc anuluje nagrywanie
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      restoreDisplay();
      cleanupWindowListeners();
      return;
    }

    const { accelerator, isModifierOnly, previewHtml } = keyboardEventToAccelerator(e);

    if (isModifierOnly && displayEl) {
      displayEl.innerHTML = previewHtml;
      return;
    }

    if (accelerator) {
      isRecording = false;
      btn.classList.remove('recording');
      cleanupWindowListeners();
      opts.onSave(accelerator);
      if (displayEl) {
        displayEl.innerHTML = formatAcceleratorDisplay(accelerator);
      }
    }
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (!isRecording) return;
    e.preventDefault();
    e.stopPropagation();

    const { isModifierOnly, previewHtml } = keyboardEventToAccelerator(e);
    if (isModifierOnly && displayEl) {
      displayEl.innerHTML = previewHtml;
    }
  };

  const handlePointerOrMouseDown = (e: MouseEvent) => {
    if (!isRecording) return;

    // Ignoruj kliknięcie lewym przyciskiem myszy tuż po włączeniu nagrywania (< 250ms)
    if (e.button === 0 && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && Date.now() - recordStartTime < 250) {
      return;
    }

    // Kliknięcie lewym przyciskiem myszy bez modyfikatorów poza nagrywarką = anuluj
    if (e.button === 0 && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      const target = e.target as HTMLElement;
      if (!btn.contains(target)) {
        restoreDisplay();
        cleanupWindowListeners();
      }
      return;
    }

    // Przyciski myszy: Mouse2 (Prawy), Mouse3 (Środkowy), Mouse4 (Wstecz), Mouse5 (Dalej) lub dowolny z modyfikatorem
    e.preventDefault();
    e.stopPropagation();

    const acc = mouseEventToAccelerator(e);
    if (acc) {
      isRecording = false;
      btn.classList.remove('recording');
      cleanupWindowListeners();
      opts.onSave(acc);
      if (displayEl) {
        displayEl.innerHTML = formatAcceleratorDisplay(acc);
      }
    }
  };

  const handleContextMenu = (e: MouseEvent) => {
    if (isRecording) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const setupWindowListeners = () => {
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('pointerdown', handlePointerOrMouseDown, true);
    window.addEventListener('auxclick', handlePointerOrMouseDown, true);
    window.addEventListener('contextmenu', handleContextMenu, true);
  };

  const cleanupWindowListeners = () => {
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('keyup', handleKeyUp, true);
    window.removeEventListener('pointerdown', handlePointerOrMouseDown, true);
    window.removeEventListener('auxclick', handlePointerOrMouseDown, true);
    window.removeEventListener('contextmenu', handleContextMenu, true);
  };

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (isRecording) {
      restoreDisplay();
      cleanupWindowListeners();
      return;
    }

    isRecording = true;
    recordStartTime = Date.now();
    btn.classList.add('recording');
    if (displayEl) {
      displayEl.innerHTML = `<span class="fc-hotkey-recording-label">🔴 Wciśnij dowolny klawisz lub przycisk myszy… (Esc anuluje)</span>`;
    }
    setupWindowListeners();
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      restoreDisplay();
      cleanupWindowListeners();
      opts.onClear();
      if (displayEl) {
        displayEl.innerHTML = formatAcceleratorDisplay('');
      }
    });
  }

  return () => {
    cleanupWindowListeners();
  };
}
