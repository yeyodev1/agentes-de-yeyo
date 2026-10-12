-- Memoria compartida de todos los agentes.

-- Todo lo publicado, en cualquier red, con su último snapshot de métricas.
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  red TEXT NOT NULL,              -- 'linkedin' | 'x'
  externo_id TEXT NOT NULL,       -- urn de LinkedIn o id del tweet
  fecha TEXT NOT NULL,            -- ISO UTC
  texto TEXT NOT NULL,
  gancho TEXT,
  estructura TEXT,
  tema TEXT,
  origen TEXT NOT NULL DEFAULT 'agente', -- 'agente' | 'diego' (dictado por Telegram)
  metricas TEXT,                  -- JSON
  metricas_at TEXT,
  borrado INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX posts_red_fecha ON posts (red, fecha);

-- Lo que Diego lee o le interesa: links por Telegram, bookmarks/likes de X, radar de cuentas.
CREATE TABLE fuentes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  origen TEXT NOT NULL,           -- 'telegram' | 'x_bookmark' | 'x_like' | 'x_radar'
  externo_id TEXT,
  autor TEXT,
  url TEXT,
  texto TEXT NOT NULL,
  metricas TEXT,
  UNIQUE (origen, externo_id)
);
CREATE INDEX fuentes_fecha ON fuentes (fecha);

-- Cosas reales que pasaron (se cuentan por Telegram o se agregan a mano).
CREATE TABLE material (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  texto TEXT NOT NULL
);

-- Reglas aprendidas: correcciones de Diego y conclusiones de las métricas.
CREATE TABLE aprendizajes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  red TEXT NOT NULL,              -- 'linkedin' | 'x' | 'todas'
  texto TEXT NOT NULL,
  origen TEXT NOT NULL,           -- 'diego' | 'metricas'
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  rol TEXT NOT NULL,              -- 'diego' | 'agente'
  texto TEXT NOT NULL,
  respondido INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  actualizado TEXT NOT NULL
);

INSERT INTO config (clave, valor, actualizado) VALUES
  ('x_cada_horas', '4', datetime('now')),
  ('x_max_dia', '8', datetime('now')),
  ('pausa_x', '0', datetime('now')),
  ('pausa_linkedin', '0', datetime('now')),
  ('radar_x', 'midudev', datetime('now'));
