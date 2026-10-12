-- Recordatorios que Diego pide por Telegram. Pana los crea y el Worker los manda a la hora.
CREATE TABLE recordatorios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  texto TEXT NOT NULL,
  cuando TEXT NOT NULL,           -- ISO UTC del próximo aviso
  repetir TEXT,                   -- null | 'diario' | 'laborables' | 'semanal' | 'mensual'
  estado TEXT NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'enviado' | 'cancelado'
  creado TEXT NOT NULL
);
CREATE INDEX recordatorios_pendientes ON recordatorios (estado, cuando);
