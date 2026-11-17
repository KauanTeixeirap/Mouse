# Mouse

Um app instalável (**PWA**) no **Android (Chrome)** para controlar o mouse e o teclado de um **PC Windows** na mesma rede Wi-Fi com baixa latência via **WebSocket seguro (`wss://`)**.

## Recursos

- **Trackpad multitoque:** mover ponteiro com aceleração suave, clique esquerdo/direito, rolagem natural/invertida, zoom por pinça (`Ctrl + scroll`), toque duplo e arrastar, e gestos de 3 dedos configuráveis.
- **Giroscópio (Air Mouse):** controla o cursor movimentando o celular no ar (tanto em pé quanto deitado) usando projeção pela gravidade, filtro One-Euro, botão de **Embreagem**, **Calibrar Centro** no monitor atual, controles de mídia/volume e **barra lateral de rolagem** para rolar páginas puxando para cima ou para baixo.
- **Teclado completo:** digitação nativa do Android (acentos e voz), teclas especiais (`Esc`, `Tab`, setas, `Delete`), modificadores *sticky* (`Ctrl`, `Alt`, `Shift`, `Win`), atalhos prontos, controles de mídia, `F1–F12` e **Meus atalhos** salvos no PC.
- **Perfis salvos no PC:** crie e alterne perfis (ex.: `Mesa`, `Sofá/TV`) com sensibilidade, tema (claro, escuro ou sistema), vibração, *Wake Lock* e atalhos sincronizados automaticamente.
- **Segurança local:** CA e certificado TLS locais gerados no PC + pareamento por QR Code de uso único ou PIN de 6 dígitos + limite de 1 celular controlando por vez.

---

## Como usar (Windows + Android)

### 1. Baixar e iniciar no PC

1. Baixe o executável `Mouse.exe` na página de **Releases** do repositório (ou execute a partir do código-fonte). https://github.com/KauanTeixeirap/Mouse/releases/tag/v0.1.2
2. Ao abrir pela primeira vez, o **Firewall do Windows** perguntará se o app pode acessar a rede. Marque **Redes privadas** e clique em **Permitir acesso**.
3. O ícone **Mouse** aparecerá na bandeja do sistema (perto do relógio). Clique nele e escolha **Configurar novo celular**.

> [!TIP]
> **Se você negou o Firewall sem querer:** abra **Segurança do Windows → Firewall e proteção de rede → Permitir um aplicativo através do firewall**, clique em **Alterar configurações**, localize `Mouse` (ou `python.exe` em desenvolvimento) e marque **Privada**.

### 2. Configuração única no celular (Android / Chrome)

1. Na janela **Configurar novo celular** no PC, escaneie o **QR Code 1** (`http://SEU_IP:8080/setup`) ou acesse esse endereço no Chrome do celular.
2. Toque em **Baixar `mouse-ca.crt`**.
3. No Android, abra **Configurações → Segurança → Criptografia e credenciais → Instalar certificado → Certificado CA** (o caminho exato varia conforme o fabricante; você pode pesquisar *"Instalar certificado"* nas configurações).
4. Selecione o arquivo `mouse-ca.crt` baixado.
   - *Nota:* O Android mostra um aviso padrão de que *"a rede pode ser monitorada"*. Isso é esperado para qualquer certificado CA local instalado manualmente.
5. Agora escaneie o **QR Code 2** (`https://SEU_IP:8443/#pair=...`) ou abra `https://SEU_IP:8443` no Chrome e digite o **PIN de 6 dígitos** exibido no PC.
6. No menu do Chrome (⋮), toque em **Adicionar à tela inicial / Instalar app** para usar em tela cheia como aplicativo **Mouse**.

---

## Rede local: IP fixo e `nomedopc.local`

### Fixar o IP do PC no roteador (Recomendado)

Como o app instalado no celular aponta para o endereço do PC (ex.: `https://192.168.1.10:8443`), é recomendável configurar uma **Reserva DHCP (IP fixo na LAN)** no painel do seu roteador associando o endereço MAC do PC sempre ao mesmo IP.

Se o IP do PC mudar mesmo assim:
- O servidor gera automaticamente um novo certificado TLS assinado pela mesma CA local (não precisa reinstalar o certificado `mouse-ca.crt`).
- A bandeja exibe uma notificação avisando para atualizar/reabrir pelo novo QR Code.

### Uso opcional de `nomedopc.local` (mDNS)

Na bandeja do PC, você pode ativar **Usar nome do PC (.local)** para anunciar o servidor via mDNS (`zeroconf`), permitindo acessar por `https://NOMEDOPC.local:8443`.

> [!NOTE]
> **Ressalvas do `.local`:** nem todas as combinações de Android, roteador e Chrome resolvem endereços `.local` de forma consistente (ou podem ter atraso de resolução). Se o endereço `.local` falhar na sua rede, use o IP local fixo.

---

## Janelas de Administrador (UIPI do Windows)

Por proteção de segurança do Windows (*User Interface Privilege Isolation — UIPI*), um aplicativo comum não consegue enviar cliques ou teclas para janelas abertas **"Como administrador"** (como o Gerenciador de Tarefas, Editor do Registro ou instaladores).

Se precisar controlar essas janelas remotamente, feche o **Mouse** pela bandeja e abra o `Mouse.exe` clicando com o botão direito → **Executar como administrador**. Para uso diário comum, recomenda-se rodar normalmente sem privilégios elevados.

---

## Desenvolvimento a partir do código

### Requisitos
- Python 3.11+
- Node.js 20+

### 1. Build do frontend (PWA)

```powershell
cd web
npm install
npx tsc --noEmit
npx vitest run
npx vite build
```

### 2. Servidor Python

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\pip.exe install -e ".[dev]"
.\.venv\Scripts\ruff.exe check .
.\.venv\Scripts\pytest.exe -q
```

Para executar com a bandeja:

```powershell
.\.venv\Scripts\python.exe -m mouse_server
```

Para executar em modo headless (sem bandeja) ou simulação (`--dry-run`, útil para testes sem mover o mouse real):

```powershell
.\.venv\Scripts\python.exe -m mouse_server --no-tray --dry-run
```

---

## Solução de problemas

- **Chrome diz "Sua conexão não é particular":** verifique se o arquivo `mouse-ca.crt` foi instalado como **Certificado CA** nas credenciais do Android e reabra o Chrome completamente.
- **Cursor para de responder em janelas de sistema:** a janela ativa está rodando como Administrador (veja a seção *Janelas de Administrador*).
- **Outro aparelho assumiu o controle:** apenas um celular controla o PC por vez para evitar conflito. Toque em **Retomar controle** no banner para voltar a controlar.
- **Quero remover um celular antigo:** na bandeja do PC, abra **Aparelhos pareados** e clique no aparelho para revogar o token dele.

---

## Como funciona por baixo dos panos

### O que é uma CA local e um certificado?
Um **certificado TLS** comprova a identidade do servidor (`192.168.x.x` / `nomedopc.local`) e habilita a criptografia HTTPS. Autoridades públicas (Let's Encrypt, Google) não emitem certificados para IPs privados de rede local. Por isso, o Mouse cria uma **CA local** no seu PC (`%APPDATA%\Mouse\certs\`) e assina o certificado do servidor com ela (validade de 397 dias). Ao instalar a CA uma única vez no Android, o Chrome confia na conexão sem avisos e libera recursos modernos como o Service Worker.

### O que é o Service Worker?
É um script em segundo plano registrado pelo PWA que armazena os arquivos da interface no celular. Graças a ele, o app abre instantaneamente (mostrando *"PC desconectado"* se o PC estiver desligado) e pode ser instalado na tela inicial em tela cheia.

### O que é `wss://`?
`wss://` é o protocolo **WebSocket sobre TLS** (a mesma criptografia do HTTPS). Ele mantém um canal bidirecional aberto continuamente entre celular e PC para enviar movimentos do mouse e teclas com latência mínima, impedindo que outros dispositivos no Wi-Fi leiam o que você digita ou injetem comandos.

### O que são FastAPI e Uvicorn?
**FastAPI** define as rotas HTTP (`/setup`, `/api/pair`), o WebSocket `/ws` e a validação das mensagens JSON com Pydantic; **Uvicorn** é o servidor ASGI assíncrono que escuta as portas de rede, gerencia a criptografia TLS e entrega os pacotes de movimento e digitação sem bloquear.
