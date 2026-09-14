export function getProductDetailsTemplate(params = {}) {
    const {
        productName = '',
        description = '',
        email = '',
    } = params;

    const now = new Date();

    const fecha = now.toLocaleDateString('es-PE', {
        timeZone: 'America/Lima'
    });

    const hora = now.toLocaleTimeString('es-PE', {
        timeZone: 'America/Lima',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    return `📢 Bienvenido a Tami Maquinarias 📢

Gracias por su interés en nuestros productos. A continuación, le proporcionamos los detalles del producto que ha consultado:

📝 Producto Consultado:
    • Nombre del Producto: ${productName}  
    • Descripción: ${description}  

📅 Fecha y Hora de Consulta:
    • Fecha: ${fecha}
    • Hora: ${hora}

Si tiene alguna otra consulta o desea más información, no dude en escribir.
`;
}