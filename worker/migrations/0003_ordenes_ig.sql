-- Órdenes de Instagram: Pana las encola con lo que Diego aprobó por Telegram
-- y la rutina cloud de Buzzfy las recoge por /api/instagram/ordenes.
CREATE TABLE ordenes_ig (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL,             -- 'dm' {usuario, texto} | 'inbox' {}
  datos TEXT NOT NULL,            -- JSON con los detalles exactos que aprobó Diego
  estado TEXT NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'hecha' | 'fallida'
  resultado TEXT
);
CREATE INDEX ordenes_ig_pendientes ON ordenes_ig (estado, id);
