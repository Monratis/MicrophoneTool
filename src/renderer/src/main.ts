import { AppUI } from './app';

function bootstrap() {
  const root = document.getElementById('root');
  if (root) {
    const app = new AppUI(root);
    void app.init().catch((err) => {
      console.error('[DeskSense] Błąd krytyczny podczas startu AppUI:', err);
    });
  } else {
    console.error('[DeskSense] Nie znaleziono kontenera #root w dokumencie HTML.');
  }
}

// Obsługa błędów globalnych w rendererze
window.addEventListener('error', (e) => {
  console.error('[DeskSense Renderer Error]:', e.error || e.message);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[DeskSense Renderer Unhandled Rejection]:', e.reason);
});

// Bezpieczne uruchomienie: jeśli DOM jest już załadowany (np. skrypty modułowe), uruchom od razu
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
