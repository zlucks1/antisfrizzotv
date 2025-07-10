import * as zlib from 'zlib';
import { parseString } from 'xml2js';
import fetch from 'node-fetch';

export interface EPGProgram {
    start: string;
    stop?: string;
    title: string;
    description?: string;
    category?: string;
    channel: string;
}

export interface EPGChannel {
    id: string;
    displayName: string;
    icon?: string;
}

export interface EPGData {
    channels: EPGChannel[];
    programs: EPGProgram[];
}

export interface EPGConfig {
    epgUrl: string;
    alternativeUrls?: string[];
    channelMapping?: { [key: string]: string[] };
    updateInterval?: number;
    cacheDir?: string;
    enabled?: boolean;
    supportedFormats?: string[];
    timeout?: number;
    maxRetries?: number;
}

export class EPGManager {
    private config: EPGConfig;
    private timeZoneOffset: string = '+2:00'; // Fuso orario italiano
    private offsetMinutes: number = 120; // Offset in minuti per l'Italia
    
    // Cache temporanea leggera con timeout breve (5 minuti)
    private tempCache: {
        data: EPGData | null;
        timestamp: number;
        isLoading: boolean;
    } = {
        data: null,
        timestamp: 0,
        isLoading: false
    };
    
    private readonly TEMP_CACHE_DURATION = 5 * 60 * 1000; // 5 minuti

    constructor(config: EPGConfig) {
        this.config = {
            enabled: true,
            supportedFormats: ['xml', 'xml.gz'],
            timeout: 30000,
            maxRetries: 3,
            ...config
        };
        
        this.validateAndSetTimezone();
        console.log('📺 EPG Manager inizializzato in modalità LIVE (senza cache persistente)');
    }

    /**
     * Valida e imposta il fuso orario
     */
    private validateAndSetTimezone(): void {
        const tzRegex = /^[+-]\d{1,2}:\d{2}$/;
        const timeZone = process.env.TIMEZONE_OFFSET || '+2:00';
        
        if (!tzRegex.test(timeZone)) {
            this.timeZoneOffset = '+2:00';
            this.offsetMinutes = 120;
            return;
        }
        
        this.timeZoneOffset = timeZone;
        const [hours, minutes] = this.timeZoneOffset.substring(1).split(':');
        this.offsetMinutes = (parseInt(hours) * 60 + parseInt(minutes)) * 
                             (this.timeZoneOffset.startsWith('+') ? 1 : -1);
    }

    /**
     * Controlla se i dati in cache temporanea sono ancora validi
     */
    private isTempCacheValid(): boolean {
        return this.tempCache.data !== null && 
               (Date.now() - this.tempCache.timestamp) < this.TEMP_CACHE_DURATION;
    }

    /**
     * Ottiene i dati EPG (con cache temporanea per ridurre chiamate HTTP)
     */
    private async getEPGData(): Promise<EPGData | null> {
        // Se la cache temporanea è valida, usala
        if (this.isTempCacheValid()) {
            return this.tempCache.data;
        }

        // Se c'è già un caricamento in corso, aspetta
        if (this.tempCache.isLoading) {
            // Aspetta che il caricamento finisca (max 10 secondi)
            for (let i = 0; i < 100; i++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (!this.tempCache.isLoading) {
                    return this.tempCache.data;
                }
            }
            return null;
        }

        // Avvia il caricamento
        this.tempCache.isLoading = true;
        
        try {
            const epgData = await this.fetchEPGData();
            if (epgData) {
                this.tempCache.data = epgData;
                this.tempCache.timestamp = Date.now();
                console.log(`📺 EPG caricato LIVE: ${epgData.channels.length} canali, ${epgData.programs.length} programmi`);
            }
            return epgData;
        } finally {
            this.tempCache.isLoading = false;
        }
    }

    /**
     * Scarica e processa l'EPG XML direttamente (senza cache persistente)
     */
    private async fetchEPGData(): Promise<EPGData | null> {
        if (!this.config.enabled) {
            console.log('📺 EPG è disabilitato nella configurazione');
            return null;
        }

        const urlsToTry = [this.config.epgUrl, ...(this.config.alternativeUrls || [])];
        
        for (const url of urlsToTry) {
            try {
                console.log(`🔄 Caricamento EPG LIVE da: ${url}`);
                
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'StreamViX/3.0.0 EPG Client'
                    },
                    timeout: this.config.timeout
                });
                
                if (!response.ok) {
                    console.error(`❌ Errore nel download EPG da ${url}: ${response.status} ${response.statusText}`);
                    continue;
                }
                
                // Determina se il file è compresso (solo se URL finisce con .gz)
                const isGzipped = url.endsWith('.gz');
                
                let xmlContent: string;
                
                if (isGzipped) {
                    console.log(`📦 File EPG compresso, decompressione in corso...`);
                    const buffer = await response.buffer();
                    xmlContent = zlib.gunzipSync(buffer).toString('utf8');
                } else {
                    xmlContent = await response.text();
                }
                
                console.log(`📥 EPG XML processato: ${xmlContent.length} caratteri`);
                
                const parsedData = await this.parseXMLEPG(xmlContent);
                if (parsedData) {
                    console.log(`✅ EPG caricato LIVE con successo da ${url}: ${parsedData.channels.length} canali, ${parsedData.programs.length} programmi`);
                    return parsedData;
                }
                
            } catch (error) {
                console.error(`❌ Errore nel caricamento EPG da ${url}:`, error);
                continue;
            }
        }
        
        console.error('❌ Impossibile caricare EPG da nessun URL');
        return null;
    }

    /**
     * Funzione di compatibilità per l'API esistente
     */
    public async updateEPG(): Promise<boolean> {
        const data = await this.fetchEPGData();
        return data !== null;
    }

    /**
     * Parsa l'XML EPG e converte in formato interno
     */
    private parseXMLEPG(xmlContent: string): Promise<EPGData | null> {
        return new Promise((resolve) => {
            parseString(xmlContent, (err: any, result: any) => {
                if (err) {
                    console.error('❌ Errore nel parsing XML EPG:', err);
                    resolve(null);
                    return;
                }

                try {
                    const channels: EPGChannel[] = [];
                    const programs: EPGProgram[] = [];

                    // Parsa i canali
                    if (result.tv && result.tv.channel) {
                        for (const channel of result.tv.channel) {
                            const channelId = channel.$.id;
                            const displayName = channel['display-name'] ? 
                                (Array.isArray(channel['display-name']) ? channel['display-name'][0]._ || channel['display-name'][0] : channel['display-name']) : 
                                channelId;
                            
                            const icon = channel.icon ? 
                                (Array.isArray(channel.icon) ? channel.icon[0].$.src : channel.icon.$.src) : 
                                undefined;

                            channels.push({
                                id: channelId,
                                displayName: displayName,
                                icon: icon
                            });
                        }
                    }

                    // Parsa i programmi
                    if (result.tv && result.tv.programme) {
                        for (const programme of result.tv.programme) {
                            const title = programme.title ? 
                                (Array.isArray(programme.title) ? programme.title[0]._ || programme.title[0] : programme.title) : 
                                'Programma sconosciuto';
                            
                            const description = programme.desc ? 
                                (Array.isArray(programme.desc) ? programme.desc[0]._ || programme.desc[0] : programme.desc) : 
                                undefined;

                            const category = programme.category ? 
                                (Array.isArray(programme.category) ? programme.category[0]._ || programme.category[0] : programme.category) : 
                                undefined;

                            programs.push({
                                start: programme.$.start,
                                stop: programme.$.stop,
                                title: title,
                                description: description,
                                category: category,
                                channel: programme.$.channel
                            });
                        }
                    }

                    resolve({ channels, programs });
                } catch (parseError) {
                    console.error('❌ Errore nel processamento dati EPG:', parseError);
                    resolve(null);
                }
            });
        });
    }

    /**
     * Ottieni l'EPG per un canale specifico
     */
    public async getEPGForChannel(channelId: string, date?: Date): Promise<EPGProgram[]> {
        const epgData = await this.getEPGData();
        if (!epgData) {
            return [];
        }

        let programs = epgData.programs.filter((p: EPGProgram) => p.channel === channelId);

        // Filtra per data se specificata
        if (date) {
            const startOfDay = new Date(date);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(date);
            endOfDay.setHours(23, 59, 59, 999);

            programs = programs.filter((p: EPGProgram) => {
                const programDate = this.parseEPGDate(p.start);
                return programDate >= startOfDay && programDate <= endOfDay;
            });
        }

        return programs.sort((a: EPGProgram, b: EPGProgram) => 
            this.parseEPGDate(a.start).getTime() - this.parseEPGDate(b.start).getTime()
        );
    }

    /**
     * Ottieni il programma corrente per un canale
     */
    public async getCurrentProgram(channelId: string): Promise<EPGProgram | null> {
        const epgData = await this.getEPGData();
        if (!epgData) {
            return null;
        }

        const now = new Date();
        const programs = epgData.programs.filter((p: EPGProgram) => p.channel === channelId);

        for (const program of programs) {
            const startTime = this.parseEPGDate(program.start);
            const endTime = program.stop ? this.parseEPGDate(program.stop) : null;

            if (startTime <= now && (!endTime || endTime > now)) {
                return program;
            }
        }

        return null;
    }

    /**
     * Ottieni il prossimo programma per un canale
     */
    public async getNextProgram(channelId: string): Promise<EPGProgram | null> {
        const epgData = await this.getEPGData();
        if (!epgData) {
            return null;
        }

        const now = new Date();
        const programs = epgData.programs
            .filter((p: EPGProgram) => p.channel === channelId && this.parseEPGDate(p.start) > now)
            .sort((a: EPGProgram, b: EPGProgram) => 
                this.parseEPGDate(a.start).getTime() - this.parseEPGDate(b.start).getTime()
            );

        return programs.length > 0 ? programs[0] : null;
    }

    /**
     * Converte la data EPG in formato Date
     */
    private parseEPGDate(epgDate: string): Date {
        // Formato EPG: YYYYMMDDHHMMSS +ZZZZ
        if (!epgDate) return new Date();
        
        try {
            const regex = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/;
            const match = epgDate.match(regex);
            
            if (!match) {
                // Fallback per formato senza timezone
                const year = parseInt(epgDate.substr(0, 4));
                const month = parseInt(epgDate.substr(4, 2)) - 1; // Month is 0-indexed
                const day = parseInt(epgDate.substr(6, 2));
                const hour = parseInt(epgDate.substr(8, 2));
                const minute = parseInt(epgDate.substr(10, 2));
                const second = parseInt(epgDate.substr(12, 2));
                
                // Assumiamo UTC e convertiamo al fuso orario italiano
                const utcDate = new Date(Date.UTC(year, month, day, hour, minute, second));
                return new Date(utcDate.getTime() + (this.offsetMinutes * 60 * 1000));
            }
            
            const [_, year, month, day, hour, minute, second, timezone] = match;
            const tzHours = timezone.substring(0, 3);
            const tzMinutes = timezone.substring(3);
            const isoString = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzHours}:${tzMinutes}`;
            
            const date = new Date(isoString);
            return isNaN(date.getTime()) ? new Date() : date;
        } catch (error) {
            console.error('Errore nel parsing della data EPG:', error);
            return new Date();
        }
    }

    /**
     * Formatta la data per la visualizzazione usando il fuso orario italiano
     */
    public formatTime(epgDate: string): string {
        const date = this.parseEPGDate(epgDate);
        // Applica l'offset del fuso orario italiano se non è già stato applicato
        const localDate = new Date(date.getTime() + (this.offsetMinutes * 60 * 1000));
        return localDate.toLocaleTimeString('it-IT', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: false
        }).replace(/\./g, ':');
    }

    /**
     * Trova il canale EPG corrispondente a un canale TV
     * Supporta epgChannelIds dal canale TV
     */
    public async findEPGChannelId(tvChannelName: string, epgChannelIds?: string[]): Promise<string | null> {
        const epgData = await this.getEPGData();
        if (!epgData) {
            return null;
        }

        // 1. Se abbiamo epgChannelIds specifici dal canale TV, provali prima
        if (epgChannelIds && Array.isArray(epgChannelIds)) {
            for (const epgId of epgChannelIds) {
                // Cerca match esatto nell'EPG
                const foundChannel = epgData.channels.find(ch => 
                    ch.id === epgId || ch.displayName === epgId
                );
                if (foundChannel) {
                    console.log(`📺 EPG Match found via epgChannelIds: ${tvChannelName} -> ${foundChannel.id} (${foundChannel.displayName})`);
                    return foundChannel.id;
                }
            }
            
            // Cerca match parziale con epgChannelIds
            for (const epgId of epgChannelIds) {
                const normalizedEpgId = epgId.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
                for (const channel of epgData.channels) {
                    const normalizedChannelId = channel.id.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
                    const normalizedDisplayName = channel.displayName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
                    
                    if (normalizedChannelId.includes(normalizedEpgId) || normalizedEpgId.includes(normalizedChannelId) ||
                        normalizedDisplayName.includes(normalizedEpgId) || normalizedEpgId.includes(normalizedDisplayName)) {
                        console.log(`📺 EPG Partial match via epgChannelIds: ${tvChannelName} -> ${channel.id} (${channel.displayName}) via ${epgId}`);
                        return channel.id;
                    }
                }
            }
        }

        // 2. Fallback: usa il nome del canale per la ricerca automatica
        const normalizedName = tvChannelName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');

        // Cerca match esatto
        for (const channel of epgData.channels) {
            const normalizedEPGName = channel.displayName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
            if (normalizedEPGName === normalizedName) {
                console.log(`📺 EPG Auto-match found: ${tvChannelName} -> ${channel.id} (${channel.displayName})`);
                return channel.id;
            }
        }

        // Cerca match parziale
        for (const channel of epgData.channels) {
            const normalizedEPGName = channel.displayName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
            if (normalizedEPGName.includes(normalizedName) || normalizedName.includes(normalizedEPGName)) {
                console.log(`📺 EPG Partial auto-match found: ${tvChannelName} -> ${channel.id} (${channel.displayName})`);
                return channel.id;
            }
        }

        console.log(`⚠️ No EPG match found for: ${tvChannelName}`);
        return null;
    }

    /**
     * Ottieni tutti i canali disponibili nell'EPG
     */
    public async getAvailableChannels(): Promise<EPGChannel[]> {
        const epgData = await this.getEPGData();
        return epgData?.channels || [];
    }

    /**
     * Ottieni statistiche sull'EPG
     */
    public async getStats(): Promise<{ channels: number; programs: number; lastUpdate: string | null }> {
        const epgData = await this.getEPGData();
        return {
            channels: epgData?.channels.length || 0,
            programs: epgData?.programs.length || 0,
            lastUpdate: new Date().toISOString() // Ora sempre attuale dato che è live
        };
    }

}
