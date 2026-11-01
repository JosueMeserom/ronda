<p align="center">
  <img src="assets/icon.svg" width="120" alt="Ronda">
</p>

# 🌉 Ronda

Extensión para navegadores Chromium que hace que **las pestañas abiertas desde un enlace hereden todo el historial de la pestaña de la que vienen**. Abres un enlace con el clic central, le das a Atrás en la pestaña nueva y vuelves a la página de origen, como si hubieras navegado en la misma pestaña.

El nombre viene del [Puente Nuevo de Ronda](https://es.wikipedia.org/wiki/Puente_Nuevo_(Ronda)): casi cien metros de piedra sobre el Tajo, uniendo la parte nueva de la ciudad con el casco antiguo. Ronda une la pestaña nueva con la vieja, para que siempre haya camino de vuelta. Es hermana de [Bayeux](https://github.com/JosueMeserom/bayeux) y [Segovia](https://github.com/JosueMeserom/segovia).

---

## 🤔 El problema

Una pestaña abierta con el clic central, con Ctrl+clic o con un `target="_blank"` nace con el historial vacío. El botón Atrás sale en gris, y si quieres volver tienes que buscar la pestaña de origen, si es que sigue abierta:

```
         pestaña normal                    Ronda
  ┌──────────────────────────┐   ┌──────────────────────────┐
  │ <- (gris)   la.nueva     │   │ <- activo   la.nueva     │
  │ historial: 1             │   │ historial: origen + 1    │
  └──────────────────────────┘   └──────────────────────────┘
     no hay camino de vuelta        Atrás lleva al origen
```

Yandex Browser lo hace de serie, desde dentro del navegador. Los demás Chromium no tienen esa opción.

---

## 🚀 Cómo se usa

Ronda aún no está en ninguna tienda, así que se instala descomprimida:

1. Descarga o clona este repositorio.
2. Abre `chrome://extensions` (`brave://extensions`, `edge://extensions`…) y activa el **modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta del repositorio.

Y ya está: abre enlaces como siempre. **Su icono la activa y la desactiva**; desactivada, muestra `OFF`.

Probada en **Brave** y **Edge** (Chromium 156). Debería funcionar en cualquier Chromium a partir del 110, pero en el resto no se ha probado.

---

## ⚙️ Cómo funciona

Chromium no deja a las extensiones escribir el historial de una pestaña, ni tiene ninguna opción para abrirla con uno. Lo único que crea una pestaña con historial es duplicar otra, así que Ronda hace un cambiazo:

1. Se abre la pestaña nueva y Ronda **espera a que cargue una página de verdad**.
2. Duplica la pestaña de origen, con todo su historial, y devuelve el foco a donde estaba.
3. Manda la copia a la dirección del enlace, la pone en el sitio de la pestaña nueva y cierra esta.

Las pestañas abiertas seguidas se procesan de una en una, en el orden en que las abriste, y quedan en fila tras la de origen.

**Lo que no toca:**

| Caso | Por qué |
|---|---|
| **Descargas** | Nunca llegan a cargar una página. El navegador o tu gestor de descargas (probado con Free Download Manager) las reciben como siempre |
| **Formularios** | La copia los pediría sin los datos enviados |
| **Ventanas emergentes** | No son pestañas normales |
| **Pestañas que van a otra ventana** | El historial no se puede llevar a otra ventana con este método |
| **Páginas internas del navegador** | No tienen un historial web detrás |
| **Páginas escritas por script** tras `window.open()` | No tienen dirección a la que mandar la copia |
| **Páginas que tardan más de 5 segundos en responder** | Se quedan como pestaña normal, sin historial, para no atascar las siguientes |

---

## ⚠️ Limitaciones

Son consecuencia de hacerlo desde una extensión; se quitarían solo desde dentro del navegador:

- **Hay un parpadeo.** Duplicar pone siempre la copia delante, sin opción para evitarlo. Ronda devuelve el foco enseguida, pero se ve un destello, sobre todo con muchas pestañas abiertas.
- **Cada enlace se pide dos veces**, una en la pestaña nueva y otra en la copia. Lo normal es que no se note, pero un **enlace de un solo uso** (confirmar un correo, entrar sin contraseña) puede gastarse en la primera y dar error en la segunda. Para esos, desactívala un momento o ábrelos en la misma pestaña.
- **La página de origen también se pide otra vez** al duplicarla, si no está en la caché. La copia se manda a otro sitio enseguida, así que no suele llegar a mostrarse.
- **Se pierde `window.opener`.** Una web que abre una pestaña con `window.open()` y luego habla con ella deja de poder hacerlo. Es lo más raro de ver, porque los inicios de sesión suelen usar ventanas emergentes, y esas no se tocan. Si una web falla, prueba a desactivarla.
- **La pestaña se sustituye un instante después de abrirse**, cuando la página empieza a cargar.

---

## 🔒 Privacidad y permisos

Ronda no se conecta a nada, no tiene cuentas, analítica ni publicidad, y solo guarda si está activada o no.

| Permiso | Para qué |
|---|---|
| `tabs` | Saber de qué pestaña viene cada una y a qué dirección va. Chromium lo avisa como "leer tu historial de navegación", pero Ronda no lo guarda ni lo envía |
| `webNavigation` | Saber cuándo ha cargado de verdad una página, y si viene de un formulario |
| `storage` | Recordar si está activada |

No pide acceso al contenido de las páginas.

Ronda se ofrece tal cual, sin garantías (licencia MIT).

---

## 🧪 Desarrollo

```bash
npm test             # en Brave
npm test -- --edge   # en Edge
npm run check        # sintaxis y manifiesto
```

Los tests no tienen dependencias. Abren un navegador de verdad, sin interfaz y con un perfil temporal, contra un servidor local, y hacen clics reales. Cubren el historial heredado, las descargas, los formularios, las ráfagas de clics y la extensión desactivada. Necesitan Node 21 o superior. Por ahora buscan los navegadores en las rutas de Windows; en otros sistemas, indica la ruta con `RONDA_BROWSER` (y el cierre del navegador usa `taskkill` solo si está disponible).

---

## 📄 Licencia

MIT. Puedes verla en [LICENSE](LICENSE).

Ronda no está afiliada, asociada, autorizada ni respaldada por Google, Brave, Microsoft ni Yandex. Sus nombres y marcas pertenecen a sus respectivos dueños.
