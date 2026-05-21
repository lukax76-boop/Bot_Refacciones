import sys
import subprocess
import os

# Enforce UTF-8 encoding on standard streams to avoid Windows charmap encoding issues
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

# =====================================================================
# 1. INYECTOR DE DEPENDENCIAS AUTOMÁTICO
# =====================================================================
try:
    from google import genai
    from google.genai import types
    from bs4 import BeautifulSoup
    import requests
except ModuleNotFoundError:
    print("📦 Instalando librerías necesarias...", file=sys.stderr)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "google-genai", "beautifulsoup4", "requests"])
    from google import genai
    from google.genai import types
    from bs4 import BeautifulSoup
    import requests

import re
import json

# =====================================================================
# 2. CONFIGURACIÓN DE LA API DE GEMINI
# =====================================================================
# Intentamos obtener del entorno, si no existe o es placeholder usamos la provista por el usuario.
api_key = os.environ.get("GEMINI_API_KEY")
if not api_key or api_key.strip() == "" or api_key == "TU_API_KEY_AQUI":
    api_key = "AIzaSyBvwRkkn7m_x5k9j9oVxJkNq7oWA2obD9o"
    os.environ["GEMINI_API_KEY"] = api_key

# =====================================================================
# 3. PASO 1: AGENTE DE IA - INTERPRETACIÓN DE FRASE
# =====================================================================
def agente_interpretar_consulta(client, mensaje_cliente):
    prompt = f"""
    Analiza el siguiente mensaje de un cliente que busca una refacción automotriz:
    "{mensaje_cliente}"
    
    Debes extraer de forma precisa:
    1. El VIN, número de serie de chasis o número de serie del motor (búscalo de 6 a 17 caracteres, descarta espacios/guiones y límpialo, guárdalo bajo la clave "vin").
    2. El nombre técnico de la refacción traducido estrictamente al INGLÉS (ej: si pide balatas es 'brake pads', si pide foco de reversa es 'back up light bulb', si pide anillos es 'piston rings', si pide llantas es 'tires').
    3. Clasifica si el vehículo es un Tráiler/Camión Pesado (True) o un Auto Convencional/Camioneta (False) analizando el VIN, la serie de motor o el contexto de la frase.
    
    Responde ÚNICAMENTE con un formato JSON estructurado como este, sin texto adicional ni bloques de código markdown:
    {{
        "vin": "EL_VIN_O_SERIE_DE_MOTOR",
        "pieza_en_ingles": "technical_term_in_english",
        "es_trailer": true/false
    }}
    """
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=prompt,
        config=types.GenerateContentConfig(response_mime_type="application/json")
    )
    return json.loads(response.text)

# =====================================================================
# 4. PASO 3: AGENTE DE IA - FILTRADO INTELIGENTE / SALVAVIDAS DE CONOCIMIENTO
# =====================================================================
def agente_extraer_y_resolver(client, texto_pagina_web, pieza_ingles, mensaje_original, vin):
    """
    PASO BLINDADO: Si el texto de internet contiene información, la IA la limpia.
    Si el texto de internet vino VACÍO (porque el carro no existe en EE.UU.), la IA activa 
    su conocimiento de memoria para darle las opciones comerciales y especificaciones al cliente.
    """
    prompt = f"""
    Estás actuando como el cerebro de un bot de WhatsApp para una refaccionaria en México.
    El cliente envió este mensaje: "{mensaje_original}"
    Identificamos el VIN: `{vin}` y estamos buscando la pieza en inglés: '{pieza_ingles}'.
    
    A continuación se te proporciona la masa de texto extraída de los buscadores en la nube.
    
    Texto de la web raspado:
    \"\"\"{texto_pagina_web[:15000]}\"\"\"
    
    INSTRUCCIÓN DE BLINDAJE:
    1. Si el texto de la web contiene números de parte válidos para el vehículo, extraélos, límpialos de menús basura y muéstralos de forma profesional en ESPAÑOL.
    2. CRÍTICO: Si el texto de la web NO contiene información útil (está vacío, o dice que no encontró resultados porque es un carro del mercado mexicano/chino como el Aveo LSG o Cavalier), tú debes usar tu propio conocimiento experto automotriz para resolver la duda del cliente de memoria.
    
    Por ejemplo, si pide focos de reversa para ese Aveo, tú sabes de memoria que usa la entrada 1156 (BA15S / P21W) de un polo y patitas parejas, y debes recomendar las opciones comerciales (Hyperleds Canbus, Auxbeam LED, o halógeno convencional de 21W) y sus ventajas. Si pide anillos, da las medidas STD (1.0mm, 1.0mm, 2.0mm) y marcas.
    
    Debes devolver un objeto JSON estructurado con exactamente estas dos claves:
    1. "respuesta_cliente": Un mensaje en ESPAÑOL claro, profesional, pulcro y directo, orientado a mostrador de refaccionaria, listo para enviarse al cliente por WhatsApp (usa emojis amigables, viñetas si aplica, y negritas).
    2. "numeros_parte": Una lista de strings con todos los códigos o números de parte sugeridos, encontrados o deducidos (ej: ["1156", "BA15S", "P21W"] o números de parte de fabricantes). Estos números se usarán para buscar en nuestra base de datos local de inventarios.
    
    Ejemplo de respuesta esperada:
    {{
        "respuesta_cliente": "¡Hola! Para tu Chevrolet Aveo con el VIN proporcionado, la refacción que buscas (foco de reversa) utiliza la entrada de foco 1156 (también conocido como BA15S o P21W). Te sugerimos las siguientes opciones comerciales:\\n\\n- *Halógeno convencional (21W)*: Excelente durabilidad estándar.\\n- *HyperLEDs Canbus / Auxbeam LED*: Mayor iluminación y sin error en tablero.\\n\\nQuedamos a tus órdenes.",
        "numeros_parte": ["1156", "BA15S", "P21W"]
    }}
    
    Responde ÚNICAMENTE con el formato JSON estructurado solicitado, sin texto adicional ni bloques de código markdown.
    """
    
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=prompt,
        config=types.GenerateContentConfig(response_mime_type="application/json")
    )
    return json.loads(response.text)

# =====================================================================
# 5. ORQUESTADOR UNIVERSAL (BOT PRINCIPAL)
# =====================================================================
def bot_universal_blindado(mensaje_usuario):
    try:
        client = genai.Client()
    except Exception as e:
        return {
            "success": False,
            "error": f"❌ Error crítico de credenciales: Asegúrate de poner una API Key válida. Detalle: {e}"
        }

    print("🧠 1. Analizando e interpretando la frase con el Agente de IA...", file=sys.stderr)
    try:
        datos = agente_interpretar_consulta(client, mensaje_usuario)
        vin = datos.get("vin", "")
        pieza_ingles = datos.get("pieza_en_ingles", "")
        es_trailer = datos.get("es_trailer", False)
        
        print(f"   • VIN Detectado: {vin}", file=sys.stderr)
        print(f"   • Término de Búsqueda Web: '{pieza_ingles}'", file=sys.stderr)
        print(f"   • Tipo de Vehículo: {'Pesado (Tráiler)' if es_trailer else 'Ligero (Auto)'}", file=sys.stderr)
    except Exception as e:
        return {
            "success": False,
            "error": f"❌ No se pudo interpretar la consulta: {str(e)}"
        }

    # PASO 2: Selección de plataformas en la nube a consultar en cascada según el tipo de vehículo
    pieza_url = pieza_ingles.replace(' ', '+')
    if es_trailer:
        plataformas = [
            f"https://www.finditparts.com/search?q={vin}+{pieza_url}",
            f"https://www.imotriz.com/search?q={vin}+{pieza_url}"
        ]
    else:
        plataformas = [
            f"https://www.rockauto.com/en/parts/{vin},{pieza_url}",
            f"https://partsouq.com/en/catalog/genuine/locate?vnum={vin}"
        ]

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    texto_acumulado_web = ""

    print("\n🌐 2. Lanzando peticiones automáticas a las plataformas cloud...", file=sys.stderr)
    for url in plataformas:
        try:
            res = requests.get(url, headers=headers, timeout=10)
            if res.status_code == 200:
                soup = BeautifulSoup(res.text, 'html.parser')
                texto_acumulado_web += soup.get_text(separator=" \n ") + "\n"
        except Exception as e:
            print(f"   • Error consultando {url}: {e}", file=sys.stderr)
            continue

    print("🧼 3. Filtrando datos y aplicando sistema de respaldo inteligente...", file=sys.stderr)
    try:
        resultado_ia = agente_extraer_y_resolver(client, texto_acumulado_web, pieza_ingles, mensaje_usuario, vin)
        return {
            "success": True,
            "vin": vin,
            "pieza_ingles": pieza_ingles,
            "es_trailer": es_trailer,
            "respuesta_cliente": resultado_ia.get("respuesta_cliente", ""),
            "numeros_parte": resultado_ia.get("numeros_parte", [])
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"❌ Error en el Agente de Extracción: {str(e)}"
        }

# =====================================================================
# 6. ENTRADA PRINCIPAL
# =====================================================================
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({
            "success": False,
            "error": "Falta el mensaje de consulta como argumento."
        }))
        sys.exit(1)
        
    consulta_usuario = sys.argv[1]
    
    # Ejecutamos el bot universal y devolvemos el resultado estructurado
    resultado = bot_universal_blindado(consulta_usuario)
    print(json.dumps(resultado, ensure_ascii=False))
